using Test
using JSON
using Statistics

include(joinpath(@__DIR__, "..", "src", "models", "dynpro.jl"))
using .DynPro

"""
Acceptance bar for the Julia port of the Rung-2 DP oracle (Envs/DynPro.py).

Two kinds of check, and the distinction matters for a hand port across languages:

  * PARITY against `dynpro_fixture.json`, golden values exported from the Python.
    numpy's PCG64 and Julia's Xoshiro give different streams from one seed, so the
    fixture carries the shocks and the entry cohort too — which makes every
    comparison here EXACT rather than statistical. A tolerance of 1e-9 is about
    float round-off and JSON's decimal round-trip, not about Monte Carlo noise.
  * INVARIANTS, the structural properties the solver must have regardless of
    calibration, ported from the thesis's scenario_suite.invariants().

Run with: julia --project=. test/dynpro_test.jl
"""

const FIX = JSON.parsefile(joinpath(@__DIR__, "dynpro_fixture.json"))

vec64(x) = Float64[Float64(v) for v in x]
"""Python .tolist() nests by ROW, so m[i][j] is element (i, j)."""
mat64(x) = [Float64(x[i][j]) for i in 1:length(x), j in 1:length(x[1])]

const P = let d = FIX["params"]
    Params(T=d["T"], G=d["G"], MU=d["MU"], W=d["W"], DISC_EMP=d["DISC_EMP"],
           DISC_ER=d["DISC_ER"], SIGMA_R=d["SIGMA_R"], SIGMA_L=d["SIGMA_L"],
           GAMMA=d["GAMMA"], LAMBDA=d["LAMBDA"], ETA=d["ETA"], ANNUITY=d["ANNUITY"],
           RR_LEGAL=d["RR_LEGAL"], RR_TARGET=d["RR_TARGET"], SATIATE=d["SATIATE"],
           BETA=d["BETA"])
end

const Fg = vec64(FIX["Fg"])
const rg = vec64(FIX["rg"])
const ag = vec64(FIX["ag"])
const NQ = FIX["grid"]["nq"]
const NPATH = FIX["grid"]["n_paths"]
const SH = (mat64(FIX["shocks"]["zR"]), mat64(FIX["shocks"]["zL"]), mat64(FIX["shocks"]["u"]))
const R0 = vec64(FIX["entry"]["R0"])
const L0 = vec64(FIX["entry"]["L0"])
const S0 = vec64(FIX["entry"]["S0"])
const TOL = 1e-9

"""Compare a simulate() result against the fixture's, field by field."""
function check_sim(got, want; tol=TOL)
    @test maximum(abs.(got[:c_by] .- vec64(want["c_by"]))) < tol
    @test maximum(abs.(got[:frac] .- vec64(want["frac"]))) < tol
    for k in (:avg, :cost, :benefit, :joint, :mean_a, :tot, :sty)
        @test isapprox(got[k], want[String(k)]; atol=tol, rtol=0)
    end
end

@testset "DynPro port" begin

    @testset "grids reproduce the Python's nodes" begin
        @test maximum(abs.(make_F_grid(n=FIX["grid"]["nF"]) .- Fg)) < TOL
        @test maximum(abs.(make_rho_grid(n=FIX["grid"]["nR"]) .- rg)) < TOL
        @test maximum(abs.(make_a_grid(n=FIX["grid"]["na"]) .- ag)) < TOL
    end

    @testset "Gauss-Hermite nodes and weights match numpy's hermgauss" begin
        zR, zL, w = gauss_hermite_2d(NQ)
        @test sum(w) ≈ 1.0 atol = 1e-12
        # sorted, because only the set of nodes is meaningful -- the flattening
        # order never escapes the quadrature sum
        @test maximum(abs.(sort(zR) .- sort(vec64(FIX["gh"]["zR"])))) < TOL
        @test maximum(abs.(sort(zL) .- sort(vec64(FIX["gh"]["zL"])))) < TOL
        @test maximum(abs.(sort(w) .- sort(vec64(FIX["gh"]["w"])))) < TOL
    end

    @testset "terminal and paid-up values are exact" begin
        @test maximum(abs.(terminal(Fg, rg, P) .- mat64(FIX["terminal"]))) < TOL
        Phi = paidup_service(Fg, rg, P)
        @test maximum(abs.(Phi[1] .- mat64(FIX["phi_0"]))) < TOL
        @test maximum(abs.(Phi[23] .- mat64(FIX["phi_22"]))) < TOL
        @test maximum(abs.(Phi[P.T + 1] .- mat64(FIX["phi_T"]))) < TOL
    end

    @testset "backward induction reproduces the Python policy" begin
        out = solve(Fg, rg, ag, P; n_quad=NQ, beta=0.0)
        @test maximum(abs.(out.policy[1] .- mat64(FIX["policy_hard"]["t0"]))) < TOL
        @test maximum(abs.(out.policy[23] .- mat64(FIX["policy_hard"]["t22"]))) < TOL
        @test maximum(abs.(out.policy[45] .- mat64(FIX["policy_hard"]["t44"]))) < TOL
        @test maximum(abs.(out.V[1] .- mat64(FIX["V_t0"]))) < TOL

        soft = solve(Fg, rg, ag, P; n_quad=NQ, beta=0.01)
        @test maximum(abs.(soft.policy[23] .- mat64(FIX["policy_soft_t22"]))) < TOL

        nc = solve(Fg, rg, ag, P; n_quad=NQ, beta=0.0, hazard=no_churn)
        @test maximum(abs.(nc.policy[23] .- mat64(FIX["policy_nochurn_t22"]))) < TOL
    end

    @testset "simulate reproduces the Python path-by-path on shared shocks" begin
        hard = solve(Fg, rg, ag, P; n_quad=NQ, beta=0.0).policy
        check_sim(simulate(hard, Fg, rg, P; R0=R0, L0=L0, S0=S0,
                           n_paths=NPATH, shocks=SH), FIX["sim_unconstrained"])

        lo, hi = 0.02 / P.GAMMA, 0.15 / P.GAMMA
        band_ag = collect(range(lo, hi; length=FIX["grid"]["na"]))
        banded = solve(Fg, rg, band_ag, P; n_quad=NQ, beta=0.0).policy
        check_sim(simulate(banded, Fg, rg, P; R0=R0, L0=L0, S0=S0, band=(lo, hi),
                           n_paths=NPATH, shocks=SH), FIX["sim_banded"])

        flat = const_policy(0.05 / P.GAMMA, P.T, length(Fg), length(rg))
        check_sim(simulate(flat, Fg, rg, P; R0=R0, L0=L0, S0=S0,
                           n_paths=NPATH, shocks=SH), FIX["sim_flat5"])
    end

    @testset "no-churn branch matches, and nobody leaves" begin
        nc = solve(Fg, rg, ag, P; n_quad=NQ, beta=0.0, hazard=no_churn).policy
        r = simulate(nc, Fg, rg, P; R0=R0, L0=L0, S0=S0, n_paths=NPATH,
                     shocks=SH, hazard=no_churn)
        @test all(r[:frac] .== 1.0)          # frac == 1 in every year
        @test all(r[:stay])                  # and every path is a stayer
        @test isnan(r[:lea])                 # so leaver RR is undefined
        check_sim(r, FIX["sim_nochurn"])
    end

    @testset "survival and the hazard match" begin
        @test maximum(abs.([tenure_hazard(t) for t in 0:(P.T - 1)] .- vec64(FIX["hazard"]))) < TOL
        @test maximum(abs.(survival(tenure_hazard, P) .- vec64(FIX["survival"]))) < TOL
    end

    @testset "track and visits outputs match" begin
        # These paths are not reached by the value comparisons above: `visits` is the
        # occupancy histogram the state-space plot draws, and `track` feeds the median
        # rho curve. A nearest-node assignment is easy to get subtly wrong (log-rho vs
        # rho, ties, the clip at the edges), so it is compared cell by cell.
        lo, hi = 0.02 / P.GAMMA, 0.15 / P.GAMMA
        band_ag = collect(range(lo, hi; length=FIX["grid"]["na"]))
        pol = solve(Fg, rg, band_ag, P; n_quad=NQ, beta=0.0).policy
        r = simulate(pol, Fg, rg, P; R0=R0, L0=L0, S0=S0, band=(lo, hi),
                     n_paths=NPATH, shocks=SH, track=true, visits=true)
        want = FIX["sim_banded_track"]

        @test isapprox(r[:mean_a], want["mean_a"]; atol=TOL, rtol=0)
        @test maximum(abs.(r[:rho_med] .- vec64(want["rho_med"]))) < TOL
        # the Python writes -1.0 where no path is present and a_by_t is NaN
        got_a = [isnan(x) ? -1.0 : x for x in r[:a_by_t]]
        @test maximum(abs.(got_a .- vec64(want["a_by_t"]))) < TOL

        pooled = reduce(+, r[:visits])
        @test sum(pooled) == sum(vec64(want["visits_by_year"]))
        @test maximum(abs.(pooled .- mat64(want["visits_pooled"]))) == 0.0
        for t in 1:P.T
            @test sum(r[:visits][t]) == want["visits_by_year"][t]
        end
    end

    # --- invariants: properties required of the solver, not of the fixture ----

    @testset "scale invariance of RR under (R,L,S)*k" begin
        @test check_scale_invariance(Fg, rg, ag, P; n_quad=NQ) < 1e-12
    end

    @testset "delta_e is exactly a LAMBDA change" begin
        d, lam_eq = check_lambda_equivalence(Fg, rg, ag, P; n_quad=NQ)
        @test d < 1e-6
        @test lam_eq ≈ 0.6106392339492219 atol = 1e-12
    end

    @testset "u -> log as eta -> 1, and continuously" begin
        dlog, dcont = check_eta_log_limit(P)
        @test dlog < 1e-12
        @test dcont < 1e-3
    end

    @testset "Phi[T] == terminal (a full-service leaver is a stayer)" begin
        @test check_phi_terminal(Fg, rg, P) == 0.0
    end

    @testset "cost and stayer adequacy increase in LAMBDA" begin
        cost, sty = check_lambda_monotone(Fg, rg, ag, P; n_quad=NQ)
        @test all(diff(cost) .> 0)
        @test all(diff(sty) .> 0)
    end

    @testset "timing is neutral when delta_f = delta_e = mu" begin
        early, late, tilt = check_timing_neutral(Fg, rg, P; n_quad=NQ)
        # The marginal condition is t-independent here, so the schedule is flat up
        # to solver noise; the thesis measures ~14% on a finer grid. This is NOT a
        # sharp test -- see check_timing_neutral's docstring.
        @test tilt < 0.25
    end
end
