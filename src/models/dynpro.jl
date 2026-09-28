module DynPro

using FastGaussQuadrature
using Random
using Statistics

export Params, make_F_grid, make_rho_grid, make_a_grid, grids,
       tenure_hazard, survival, no_churn,
       u, F_next, rho_next, gauss_hermite_2d, bilinear,
       paidup_service, terminal, solve, simulate,
       const_policy, schedule_policy, new_plan_init,
       design_flat, design_age, get_design,
       check_scale_invariance, check_lambda_equivalence, check_eta_log_limit,
       check_phi_terminal, check_lambda_monotone, check_timing_neutral,
       lambda_equivalent

"""
Julia port of the Rung-2 DP oracle from
https://github.com/korilium/KuLeuven-Thesis-Second-Pillar-Pension-Optimisation-for-Belgian-Employers-via-Deep-RL
(`Envs/DynPro.py`, with the calibration from `Envs/economy.py`). Same recursions,
same defaults — years are 0-indexed (t = 0..T-1) to match the source, with arrays
offset by one for Julia's 1-indexing, exactly as in `pension.jl`.

Two deliberate departures from the Python, both noted where they occur:

  * parameters travel in a `Params` struct rather than as bare keyword arguments.
    The Python reads them as MODULE GLOBALS that its sweep harness rebinds with
    `setattr`; that is unusable under a server, where two concurrent requests
    would corrupt each other. There are 17 of them, which is too many to thread
    individually the way `pension.jl` does with its 8.
  * `simulate` accepts PRE-DRAWN shocks. numpy's PCG64 and Julia's Xoshiro give
    different streams from the same seed, so feeding numpy-drawn shocks through
    both is the only way to check this port against the original exactly — the
    same reason `pension.jl`'s `run_batch` takes its shocks as an argument.

The three-dimensional arrays of the Python (`V`, `policy`, `Phi`) are represented
as vectors of (NF, NR) matrices, which keeps the Python's index order while
staying contiguous in Julia's column-major layout.
"""

# --- parameters -------------------------------------------------------------
# Defaults are the committed calibration of Envs/economy.py.

@kwdef struct Params
    T::Int = 45                 # career length in years
    G::Float64 = 0.03           # WAP guarantee rate
    MU::Float64 = 0.03          # credited (Branch 21) tariff
    W::Float64 = 0.025          # salary growth
    DISC_EMP::Float64 = 0.03    # employee discount (risk-free/OLO)
    DISC_ER::Float64 = 0.05     # employer discount (cost of capital)
    SIGMA_R::Float64 = 0.05     # asset shock
    SIGMA_L::Float64 = 0.02     # guarantee shock
    GAMMA::Float64 = 0.15       # funding capacity: contribution = a * GAMMA * S
    LAMBDA::Float64 = 0.5       # employee weight in the joint objective
    ETA::Float64 = 2.0          # CRRA curvature over the replacement rate
    ANNUITY::Float64 = 15.0     # capital -> annual pension
    RR_LEGAL::Float64 = 0.43    # 1st-pillar replacement; the 2nd pillar sits ON TOP
    RR_TARGET::Float64 = 0.70   # total-adequacy target across pillars
    SATIATE::Bool = false       # cap RR at RR_TARGET in the utility
    BETA::Float64 = 0.01        # policy-EXTRACTION temperature, relative to the local Q-spread
    S0::Float64 = 1.0
end

"""Copy with overrides: `@kwdef` generates only the all-keyword constructor, and
the invariants need to vary one field at a time off a committed baseline."""
Params(p::Params; kw...) =
    Params(; (f => get(kw, f, getfield(p, f)) for f in fieldnames(Params))...)

"""Normalized (Box-Cox) CRRA utility, u(1) = 0 and u'(1) = 1 for every eta.
The eta -> 1 limit IS log, which is the removable singularity the Python
handles the same way."""
function u(x::Real, p::Params)
    abs(p.ETA - 1.0) < 1e-9 && return log(x)
    return (x^(1.0 - p.ETA) - 1.0) / (1.0 - p.ETA)
end

# --- transitions ------------------------------------------------------------

F_next(F, l, zR, zL, p::Params) =
    (F + l) / (1.0 + l) * exp((p.MU - p.G) + p.SIGMA_R * zR - p.SIGMA_L * zL)

rho_next(rho, l, zL, p::Params) =
    (1.0 + p.W) * rho / ((1.0 + l) * exp(p.G + p.SIGMA_L * zL))

"""Tensor-product Gauss-Hermite over the two independent shocks. The product
form is valid only because the joint density of two independent standard
normals factorises. Returns (zR, zL, w) flattened in the Python's C order
(zR varying slowest), though only the sum over nodes is ever used."""
function gauss_hermite_2d(n::Integer=15)
    x, w = gausshermite(n)
    z = sqrt(2.0) .* x            # rescale the nodes to the standard-normal scale
    om = w ./ sqrt(pi)            # weights sum to one
    Q = n * n
    zR = Vector{Float64}(undef, Q)
    zL = Vector{Float64}(undef, Q)
    wq = Vector{Float64}(undef, Q)
    k = 0
    for i in 1:n, j in 1:n
        k += 1
        zR[k] = z[i]; zL[k] = z[j]; wq[k] = om[i] * om[j]
    end
    return zR, zL, wq
end

# --- grids ------------------------------------------------------------------

function make_F_grid(; F_max::Real=3.0, n::Integer=241)
    g = collect(range(0.0, F_max; length=n))
    @assert abs(g[argmin(abs.(g .- 1.0))] - 1.0) < 1e-12 "F=1 must be a node"
    return g
end

"""Log-spaced grid for rho = S/L.

lo = 0.01 (not 0.3) because careers genuinely reach it: under heavy funding the
median rho falls to ~0.13 by t = 44, and `bilinear` CLIPS anything below the
floor. Since RR2 = max(F,1)/(ANNUITY*rho), clipping rho from below caps the
attainable replacement rate, so a floor of 0.3 made the solver blind to the
outcomes that heavy contribution actually produces — it under-valued high-a
policies by up to 57% and suppressed stayer RR by ~28pp."""
make_rho_grid(; lo::Real=0.01, hi::Real=35.0, n::Integer=91) =
    exp.(range(log(lo), log(hi); length=n))

make_a_grid(; n::Integer=41) = collect(range(0.0, 1.0; length=n))

grids(; nF::Integer=145, nR::Integer=91, na::Integer=31) =
    (make_F_grid(n=nF), make_rho_grid(n=nR), make_a_grid(n=na))

# --- churn ------------------------------------------------------------------

"""Belgian tenure hazard: ~12%/yr early -> ~2.5%/yr long-tenure floor, giving
~45% staying 10+ years and ~15% a full career (Goulart & Oesch 2024,
OECD/Eurostat)."""
tenure_hazard(t::Integer; h0::Real=0.12, hinf::Real=0.025, tau::Real=7.0) =
    hinf + (h0 - hinf) * exp(-t / tau)

"""The no-churn benchmark. The Python passes `hazard=None` to `solve`; here a
zero function serves both `solve` and `simulate`, and at h = 0 the branch-blend
reduces to V[t+1] exactly."""
no_churn(t::Integer) = 0.0

function survival(hazard, p::Params)
    s = ones(Float64, p.T + 1)
    for t in 0:(p.T - 1)
        s[t + 2] = s[t + 1] * (1.0 - hazard(t))
    end
    return s
end

# --- policies and plan-entry states -----------------------------------------

const_policy(a::Real, n_years::Integer, nF::Integer, nR::Integer) =
    [fill(float(a), nF, nR) for _ in 1:n_years]

"""Lift a STATE-INDEPENDENT schedule a(t) to a policy. The market designs are
scale-free functions of t alone, so they need no extra state and `simulate`
reads them through the same bilinear lookup as an optimised policy — which is
what makes the two directly comparable. `a_of_t` is in CAPACITY-FRACTION units
(contribution = a*GAMMA*S), not percent of salary."""
function schedule_policy(a_of_t, nF::Integer, nR::Integer, p::Params)
    return [fill(clamp(float(a_of_t(t)), 0.0, 1.0), nF, nR) for t in 0:(p.T - 1)]
end

"""Fresh plans: F0 ~ 1, high rho (liability small relative to salary)."""
function new_plan_init(n::Integer, rng::AbstractRNG;
                       rho_lo::Real=15.0, rho_hi::Real=34.0, F_sd::Real=0.08)
    F0 = clamp.(1.0 .+ F_sd .* randn(rng, n), 0.5, 1.5)
    rho0 = exp.(log(rho_lo) .+ (log(rho_hi) - log(rho_lo)) .* rand(rng, n))
    return F0, ones(Float64, n), rho0
end

# --- market plan designs (from benchmark_suite.DESIGNS) ----------------------
# Rates are FRACTIONS OF SALARY; the caller divides by GAMMA to get the control.
# Named design_* rather than plan_* because pension.jl exports plan_age too, and
# the two differ: that one returns a PREMIUM (rate * S), this one returns a RATE.
# The two-tier ceiling split is deliberately absent: it compares a salary LEVEL
# against a fixed ceiling, while the model is homogeneous of degree 0 in
# (R, L, S), so the ceiling would have to enter the state as a further ratio.

design_flat(rate::Real) = t -> rate
design_age(rate0::Real, step::Real, band::Integer) = t -> rate0 + step * (t ÷ band)

function get_design(name::AbstractString; rate=0.05, rate0=0.03, step=0.01, band=10)
    name == "flat" && return design_flat(rate)
    name == "age"  && return design_age(rate0, step, band)
    error("unknown design type: $name")
end

# --- bilinear interpolation over (F, log rho) -------------------------------

"""Scalar bilinear lookup on (Fg, lrg). Queries off the grid are CLIPPED to the
edge, which is why the rho floor matters — see `make_rho_grid`."""
@inline function bilinear(Fg::Vector{Float64}, lrg::Vector{Float64},
                          V::Matrix{Float64}, Fq::Float64, lrq::Float64)
    NF = length(Fg); NR = length(lrg)
    Fq = clamp(Fq, Fg[1], Fg[NF])
    lrq = clamp(lrq, lrg[1], lrg[NR])
    iF = clamp(searchsortedfirst(Fg, Fq) - 1, 1, NF - 1)
    iR = clamp(searchsortedfirst(lrg, lrq) - 1, 1, NR - 1)
    tF = (Fq - Fg[iF]) / (Fg[iF + 1] - Fg[iF])
    tR = (lrq - lrg[iR]) / (lrg[iR + 1] - lrg[iR])
    @inbounds return (V[iF, iR] * (1 - tF) * (1 - tR) + V[iF + 1, iR] * tF * (1 - tR)
                      + V[iF, iR + 1] * (1 - tF) * tR + V[iF + 1, iR + 1] * tF * tR)
end

# --- terminal and paid-up values --------------------------------------------

"""Per-leave-cohort paid-up value Phi[tau](F, rho), in closed form.

On departure the contract goes paid-up: contributions cease, the reserve goes on
earning the locked credited return MU, and the liability hard-freezes (L' = L).
Freezing the contract freezes its risk too, so Phi carries NO expectation — it is
a single roll-forward over the remaining m = T - tau years:
    F -> F*exp(MU*m),  rho -> rho*(1+W)^m.

The leaver keeps their FULL vested pot but is judged against a service-pro-rated
target on the occupational gap only, so tau = T reproduces `terminal` exactly."""
function paidup_service(Fg::Vector{Float64}, rg::Vector{Float64}, p::Params)
    NF, NR = length(Fg), length(rg)
    Phi = [Matrix{Float64}(undef, NF, NR) for _ in 0:p.T]
    for tau in 0:p.T
        m = p.T - tau
        s = tau / p.T
        target = p.RR_LEGAL + s * (p.RR_TARGET - p.RR_LEGAL)
        # target hits 0 only at tau = 0 AND RR_LEGAL = 0; the limit is 0, and the
        # floor only keeps the intermediate rr/target finite.
        target = max(target, 1e-12)
        M = Phi[tau + 1]
        for j in 1:NR
            rp = rg[j] * (1.0 + p.W)^m
            for i in 1:NF
                Fp = Fg[i] * exp(p.MU * m)
                rr2 = max(Fp, 1.0) / (p.ANNUITY * rp)     # FULL vested pot
                emp = p.LAMBDA * target * p.ANNUITY * u((p.RR_LEGAL + rr2) / target, p) *
                      exp(-p.DISC_EMP * p.T)
                short = max(1.0 - Fp, 0.0) / rp
                empr = (1.0 - p.LAMBDA) * short * exp(-p.DISC_ER * p.T)
                @inbounds M[i, j] = emp - empr
            end
        end
    end
    return Phi
end

function terminal(Fg::Vector{Float64}, rg::Vector{Float64}, p::Params)
    NF, NR = length(Fg), length(rg)
    M = Matrix{Float64}(undef, NF, NR)
    for j in 1:NR, i in 1:NF
        rr = p.RR_LEGAL + max(Fg[i], 1.0) / (rg[j] * p.ANNUITY)
        p.SATIATE && (rr = min(rr, p.RR_TARGET))   # no reward above the target
        emp = p.LAMBDA * p.RR_TARGET * p.ANNUITY * u(rr / p.RR_TARGET, p) *
              exp(-p.DISC_EMP * p.T)
        empr = (1.0 - p.LAMBDA) * max(1.0 - Fg[i], 0.0) / rg[j] * exp(-p.DISC_ER * p.T)
        @inbounds M[i, j] = emp - empr
    end
    return M
end

"""a_soft = sum_a a * softmax((Q - max Q) / (beta * spread)), with spread the
local max_a Q - min_a Q. beta is RELATIVE, not in Q units, because Q is not
scale-free in the reward: dividing by the local spread makes the readout exactly
invariant to any affine rescaling Q -> alpha*Q + c. Where the spread is 0 all
actions are tied and the weights come out uniform, which is right for a tie."""
function soft_readout!(out::Matrix{Float64}, Qstack::Vector{Matrix{Float64}},
                       ag::Vector{Float64}, beta::Float64)
    NF, NR = size(out)
    na = length(ag)
    for j in 1:NR, i in 1:NF
        qmax = -Inf; qmin = Inf
        @inbounds for k in 1:na
            q = Qstack[k][i, j]
            q > qmax && (qmax = q)
            q < qmin && (qmin = q)
        end
        spread = qmax - qmin
        denom = beta * (spread > 0 ? spread : 1.0)
        wsum = 0.0; asum = 0.0
        @inbounds for k in 1:na
            wk = exp((Qstack[k][i, j] - qmax) / denom)
            wsum += wk
            asum += wk * ag[k]
        end
        @inbounds out[i, j] = asum / wsum
    end
    return out
end

# --- backward induction ------------------------------------------------------

"""Backward induction for the committed (churn-aware) objective.

Leaving is a hazard on the horizon, not a state variable: at each step the
continuation is the branch-blend
    Vb = (1 - h(t)) * V[t+1] + h(t) * Phi[t+1],
with Phi the paid-up companion value. Both branches pay year t's contribution and
land at the same in-force state — the worker earned the year — so the freeze
applies only from t+1. Pass `hazard = no_churn` for the no-churn benchmark.

`beta` is the policy-EXTRACTION temperature (see `soft_readout!`): 0 gives the
hard argmax, > 0 gives the soft readout with the argmax also returned as
`policy_hard`. V[t] = max_a Q either way, so beta never changes the objective."""
function solve(Fg::Vector{Float64}, rg::Vector{Float64}, ag::Vector{Float64},
               p::Params=Params(); n_quad::Integer=5, hazard=tenure_hazard,
               beta::Union{Nothing,Real}=nothing)
    NF, NR, na = length(Fg), length(rg), length(ag)
    zR, zL, wq = gauss_hermite_2d(n_quad)
    Q = length(wq)
    lrg = log.(rg)
    beta = beta === nothing ? p.BETA : float(beta)
    need_Q = beta > 0

    Phi = paidup_service(Fg, rg, p)
    V = [Matrix{Float64}(undef, NF, NR) for _ in 0:p.T]
    policy = [Matrix{Float64}(undef, NF, NR) for _ in 1:p.T]
    hard = need_Q ? [Matrix{Float64}(undef, NF, NR) for _ in 1:p.T] : nothing
    V[p.T + 1] = terminal(Fg, rg, p)

    Vnext = Matrix{Float64}(undef, NF, NR)
    best = Matrix{Float64}(undef, NF, NR)
    abest = Matrix{Float64}(undef, NF, NR)
    Qstack = need_Q ? [Matrix{Float64}(undef, NF, NR) for _ in 1:na] : Matrix{Float64}[]
    # rho' and its interpolation weights do not depend on F, so they are hoisted
    # out of the innermost loop — same arithmetic as the Python's broadcast.
    iR = Matrix{Int}(undef, NR, Q)
    tR = Matrix{Float64}(undef, NR, Q)

    for t in (p.T - 1):-1:0
        h = float(hazard(t))
        @inbounds for j in 1:NR, i in 1:NF
            Vnext[i, j] = (1.0 - h) * V[t + 2][i, j] + h * Phi[t + 2][i, j]
        end
        fill!(best, -Inf); fill!(abest, 0.0)
        flow_unit = -(1.0 - p.LAMBDA) * p.GAMMA * (1.0 + p.W)^(-(p.T - t)) *
                    exp(-p.DISC_ER * t)

        for (k, a) in enumerate(ag)
            @inbounds for j in 1:NR
                l = a * p.GAMMA * rg[j]
                for q in 1:Q
                    lrq = clamp(log(rho_next(rg[j], l, zL[q], p)), lrg[1], lrg[NR])
                    ir = clamp(searchsortedfirst(lrg, lrq) - 1, 1, NR - 1)
                    iR[j, q] = ir
                    tR[j, q] = (lrq - lrg[ir]) / (lrg[ir + 1] - lrg[ir])
                end
            end
            Qk = need_Q ? Qstack[k] : best   # scratch when the soft path is off
            @inbounds for j in 1:NR
                l = a * p.GAMMA * rg[j]
                for i in 1:NF
                    cont = 0.0
                    for q in 1:Q
                        Fq = clamp(F_next(Fg[i], l, zR[q], zL[q], p), Fg[1], Fg[NF])
                        iF = clamp(searchsortedfirst(Fg, Fq) - 1, 1, NF - 1)
                        tF = (Fq - Fg[iF]) / (Fg[iF + 1] - Fg[iF])
                        ir = iR[j, q]; tr = tR[j, q]
                        vi = (Vnext[iF, ir] * (1 - tF) * (1 - tr)
                              + Vnext[iF + 1, ir] * tF * (1 - tr)
                              + Vnext[iF, ir + 1] * (1 - tF) * tr
                              + Vnext[iF + 1, ir + 1] * tF * tr)
                        cont += vi * wq[q]
                    end
                    qval = flow_unit * a + cont
                    need_Q && (Qk[i, j] = qval)
                    if qval > best[i, j]
                        best[i, j] = qval
                        abest[i, j] = a
                    end
                end
            end
        end

        copyto!(V[t + 1], best)
        if need_Q
            copyto!(hard[t + 1], abest)
            soft_readout!(policy[t + 1], Qstack, ag, beta)
        else
            copyto!(policy[t + 1], abest)
        end
    end
    return (Fg=Fg, rg=rg, ag=ag, V=V, policy=policy, policy_hard=hard)
end

# --- forward evaluation ------------------------------------------------------

"""Canonical forward Monte-Carlo of a reduced policy a*(t, F, rho) under the
committed model: Belgian churn (immediate-vesting, paid-up leavers), the split
discount, and the service-pro-rated adequacy target.

`shocks` is `(zR, zL, uchurn)`, each (n_paths, T). Passing them in rather than
drawing them is what allows an exact check against the Python — see the module
docstring. When omitted they are drawn from `Xoshiro(seed)`, which does NOT
reproduce numpy."""
function simulate(policy::Vector{Matrix{Float64}}, Fg::Vector{Float64},
                  rg::Vector{Float64}, p::Params=Params();
                  R0=1.0, L0=1.0, S0=nothing, band=nothing, n_paths::Integer=30_000,
                  seed::Integer=7, hazard=tenure_hazard, shocks=nothing,
                  track::Bool=false, visits::Bool=false)
    NF, NR = length(Fg), length(rg)
    lrg = log.(rg)
    n = n_paths
    R = R0 isa Real ? fill(float(R0), n) : collect(float.(R0))
    L = L0 isa Real ? fill(float(L0), n) : collect(float.(L0))
    S = S0 === nothing ? fill(rg[NR], n) :
        (S0 isa Real ? fill(float(S0), n) : collect(float.(S0)))
    ST = S .* (1.0 + p.W)^p.T
    lo, hi = band === nothing ? (0.0, 1.0) : (float(band[1]), float(band[2]))

    if shocks === nothing
        rng = Xoshiro(seed)
        zR = randn(rng, n, p.T); zL = randn(rng, n, p.T); uch = rand(rng, n, p.T)
    else
        zR, zL, uch = shocks
    end

    present = trues(n)
    leave_t = fill(float(p.T), n)
    cost = zeros(n); a_sum = zeros(n)
    a_by_t = fill(NaN, p.T); rho_med = fill(NaN, p.T)
    frac = zeros(p.T); c_by = zeros(p.T)
    visit = visits ? [zeros(Float64, NF, NR) for _ in 1:p.T] : nothing
    a = zeros(n)

    for t in 0:(p.T - 1)
        npresent = 0
        @inbounds for i in 1:n
            F = R[i] / L[i]; rho = S[i] / L[i]
            ai = clamp(bilinear(Fg, lrg, policy[t + 1], F, log(rho)), lo, hi)
            a[i] = present[i] ? ai : 0.0
            present[i] && (npresent += 1)
        end
        frac[t + 1] = npresent / n
        csum = 0.0
        @inbounds for i in 1:n
            present[i] && (csum += a[i] * p.GAMMA)
        end
        c_by[t + 1] = npresent > 0 ? csum / npresent * 100 : 0.0

        if visits && npresent > 0
            V = visit[t + 1]
            @inbounds for i in 1:n
                present[i] || continue
                Fc = clamp(R[i] / L[i], Fg[1], Fg[NF])
                lrc = clamp(log(S[i] / L[i]), lrg[1], lrg[NR])
                # nearest node, matching the Python's argmin assignment
                bi = 1; bd = Inf
                for k in 1:NF
                    d = abs(Fg[k] - Fc)
                    if d < bd; bd = d; bi = k; end
                end
                bj = 1; bd = Inf
                for k in 1:NR
                    d = abs(lrg[k] - lrc)
                    if d < bd; bd = d; bj = k; end
                end
                V[bi, bj] += 1.0
            end
        end
        if track && npresent > 0
            s = 0.0; rhos = Float64[]
            @inbounds for i in 1:n
                present[i] || continue
                s += a[i]
                push!(rhos, S[i] / L[i])
            end
            a_by_t[t + 1] = s / npresent
            rho_med[t + 1] = median(rhos)
        end

        h = hazard(t)
        @inbounds for i in 1:n
            a_sum[i] += a[i]
            c = a[i] * p.GAMMA * S[i]
            if present[i]
                cost[i] += (c / ST[i]) * exp(-p.DISC_ER * t)
                # in force: contribute and carry the asset shock. Paid-up: the reserve
                # compounds at the LOCKED credited return with no further shock,
                # matching paidup_service. L freezes on both counts once absent.
                R[i] = (R[i] + c) * exp(p.MU + p.SIGMA_R * zR[i, t + 1])
                L[i] = (L[i] + c) * exp(p.G + p.SIGMA_L * zL[i, t + 1])
            else
                R[i] = R[i] * exp(p.MU)
            end
            S[i] *= (1.0 + p.W)
            if present[i] && uch[i, t + 1] < h
                leave_t[i] = t + 1
                present[i] = false
            end
        end
    end

    RRtot = Vector{Float64}(undef, n)
    benefit = Vector{Float64}(undef, n)
    stay = falses(n)
    @inbounds for i in 1:n
        payout = max(R[i], L[i])
        short = max(L[i] - R[i], 0.0)
        cost[i] += (short / ST[i]) * exp(-p.DISC_ER * p.T)
        RR2 = payout / (p.ANNUITY * ST[i])
        svc = min(leave_t[i] / p.T, 1.0)
        target = p.RR_LEGAL + svc * (p.RR_TARGET - p.RR_LEGAL)
        benefit[i] = exp(-p.DISC_EMP * p.T) * target * p.ANNUITY *
                     u((p.RR_LEGAL + RR2) / target, p)
        RRtot[i] = p.RR_LEGAL + RR2
        stay[i] = leave_t[i] >= p.T
    end

    mb = mean(benefit); mc = mean(cost)
    fsum = sum(frac)
    out = Dict{Symbol,Any}(
        :benefit => mb, :cost => mc,
        :joint => p.LAMBDA * mb - (1 - p.LAMBDA) * mc,
        :mean_a => mean(a_sum ./ p.T),
        :c_by => c_by, :frac => frac,
        :avg => fsum > 0 ? sum(c_by .* frac) / fsum : NaN,
        :RR_tot => RRtot, :stay => stay,
        :tot => median(RRtot),
        :sty => any(stay) ? median(RRtot[stay]) : NaN,
        :lea => any(.!stay) ? median(RRtot[.!stay]) : NaN,
    )
    if track
        out[:a_by_t] = a_by_t
        out[:rho_med] = rho_med
    end
    visits && (out[:visits] = visit)
    return out
end

# --- invariants ---------------------------------------------------------------
# Structural properties the solver is REQUIRED to have, ported from the thesis's
# scenario_suite.invariants(). They are what makes the oracle credible as a
# benchmark: a number from an unverified oracle is not a benchmark. Same role as
# `check_batch_consistency` in pension.jl.

"""The LAMBDA that reproduces (lam, de_new) at the reference DISC_EMP. delta_e
multiplies the employee leg by exp(-delta_e*T) and nothing else, so it is
redundant with LAMBDA up to a positive rescale of the objective, which leaves the
argmax alone."""
function lambda_equivalent(de_new::Real, lam::Real, de_ref::Real, T::Integer)
    A = lam * exp(-de_new * T)
    B = 1.0 - lam
    return A / (A + B * exp(-de_ref * T))
end

"""The model is homogeneous of degree 0 in (R, L, S): scaling all three leaves
every replacement rate untouched."""
function check_scale_invariance(Fg, rg, ag, p::Params=Params(); n_quad=3, n=400, seed=3, k=5.0)
    pol = solve(Fg, rg, ag, p; n_quad=n_quad).policy
    rng = Xoshiro(seed)
    zR = randn(rng, n, p.T); zL = randn(rng, n, p.T); uch = rand(rng, n, p.T)
    sh = (zR, zL, uch)
    r1 = simulate(pol, Fg, rg, p; R0=1.0, L0=1.0, S0=20.0, n_paths=n, shocks=sh)
    rk = simulate(pol, Fg, rg, p; R0=k, L0=k, S0=k * 20.0, n_paths=n, shocks=sh)
    return maximum(abs.(rk[:RR_tot] .- r1[:RR_tot]) ./ abs.(r1[:RR_tot]))
end

"""delta_e is exactly a LAMBDA change -- not an independent degree of freedom."""
function check_lambda_equivalence(Fg, rg, ag, p::Params=Params(); n_quad=3,
                                  lam=0.5, de_new=0.02)
    lam_eq = lambda_equivalent(de_new, lam, p.DISC_EMP, p.T)
    pa = solve(Fg, rg, ag, Params(p; LAMBDA=lam, DISC_EMP=de_new); n_quad=n_quad, beta=0.0).policy
    pb = solve(Fg, rg, ag, Params(p; LAMBDA=lam_eq); n_quad=n_quad, beta=0.0).policy
    d = maximum(maximum(abs.(a .- b)) for (a, b) in zip(pa, pb))
    return d, lam_eq
end

"""eta -> 1 is continuous and equals log utility."""
function check_eta_log_limit(p::Params=Params())
    x = [0.4, 1.0, 2.5]
    p1 = Params(p; ETA=1.0)
    pe = Params(p; ETA=1.0 + 1e-4)
    dlog = maximum(abs.([u(xi, p1) for xi in x] .- log.(x)))
    dcont = maximum(abs.([u(xi, p1) - u(xi, pe) for xi in x]))
    return dlog, dcont
end

"""The leaver and stayer terminal conditions coincide at tau = T: a full-service
leaver is a stayer."""
check_phi_terminal(Fg, rg, p::Params=Params()) =
    maximum(abs.(paidup_service(Fg, rg, p)[p.T + 1] .- terminal(Fg, rg, p)))

"""Employer cost and stayer adequacy are both monotone in LAMBDA.

The lambdas stay BELOW the saturation point on purpose. Above lambda ~= 0.6 the
optimum is pinned at the contribution band's ceiling, so cost and adequacy stop
responding (measured: 0.569 vs 0.570, 0.973 vs 0.973) and a strict-increase test
would fail on saturation rather than on any defect."""
function check_lambda_monotone(Fg, rg, ag, p::Params=Params(); n_quad=3,
                               lams=(0.2, 0.3, 0.4, 0.5), n=400, seed=3)
    cost = Float64[]; sty = Float64[]
    rng = Xoshiro(seed)
    R0, L0, S0 = new_plan_init(n, rng)
    sh = (randn(rng, n, p.T), randn(rng, n, p.T), rand(rng, n, p.T))
    for lam in lams
        pol = solve(Fg, rg, ag, Params(p; LAMBDA=lam); n_quad=n_quad).policy
        r = simulate(pol, Fg, rg, Params(p; LAMBDA=lam);
                     R0=R0, L0=L0, S0=S0, n_paths=n, shocks=sh)
        push!(cost, r[:cost]); push!(sty, r[:sty])
    end
    return cost, sty
end

"""Frictionless benchmark: with delta_f = delta_e = mu the benefit/cost ratio
exp((mu - d_e)T + (d_f - mu)t) is 1 for every t, so timing must be neutral.

The thesis measures a ~14% residual tilt here WITH churn, and the solution is
entirely interior. Turning churn off is NOT a sharper version of this test: the
plan then needs far more total funding, the band ceiling binds for the first
years, and the schedule is set by that corner rather than by the marginal
condition."""
function check_timing_neutral(Fg, rg, p::Params=Params(); n_quad=3, na=15, n=400, seed=3)
    q = Params(p; DISC_ER=p.MU, DISC_EMP=p.MU)
    lo, hi = 0.02 / q.GAMMA, 0.15 / q.GAMMA
    ag = collect(range(lo, hi; length=na))
    pol = solve(Fg, rg, ag, q; n_quad=n_quad).policy
    rng = Xoshiro(seed)
    R0, L0, S0 = new_plan_init(n, rng)
    sh = (randn(rng, n, q.T), randn(rng, n, q.T), rand(rng, n, q.T))
    r = simulate(pol, Fg, rg, q; R0=R0, L0=L0, S0=S0, band=(lo, hi), n_paths=n, shocks=sh)
    early = mean(r[:c_by][1:10]); late = mean(r[:c_by][36:end])
    return early, late, abs(early - late) / max(early, late)
end

end # module
