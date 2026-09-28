using Oxygen
using JSON
using Random          # Xoshiro, for the per-seed entry cohorts
using Statistics      # mean, for the across-seed ranges

include(joinpath(@__DIR__, "models", "pension.jl"))
using .Pension

include(joinpath(@__DIR__, "models", "dynpro.jl"))
using .DynPro

# --- request/response shapes -------------------------------------------

@kwdef struct EvaluateRequest
    plan::String = "fixed"        # "fixed" | "step" | "age"

    rate::Float64 = 0.05          # plan_fixed
    rate_low::Float64 = 0.04      # plan_step
    rate_high::Float64 = 0.10     # plan_step
    ceiling::Float64 = 1.5        # plan_step
    rate0::Float64 = 0.03         # plan_age
    step::Float64 = 0.01          # plan_age
    band::Int = 10                # plan_age

    T::Int = 45
    G::Float64 = 0.0250
    MU::Float64 = 0.025
    LAMBDA::Float64 = 0.5
    S0::Float64 = 1.0
    W::Float64 = 0.025
    DISC::Float64 = 0.03
    SIGMA::Float64 = 0.02

    n_episodes::Int = 1_000_000   # matches basicEnv.py's own default; capped below regardless
    n_eval::Int = 2000
    seed::Int = 0
end

@kwdef struct DynProRequest
    # economy (defaults are the thesis's committed calibration)
    T::Int = 45
    G::Float64 = 0.03             # WAP guarantee rate
    MU::Float64 = 0.03            # credited tariff
    W::Float64 = 0.025            # salary growth
    DISC_EMP::Float64 = 0.03      # employee discount
    DISC_ER::Float64 = 0.05       # employer discount
    SIGMA_R::Float64 = 0.05
    SIGMA_L::Float64 = 0.02
    GAMMA::Float64 = 0.15         # funding capacity
    LAMBDA::Float64 = 0.5         # employee weight
    ETA::Float64 = 2.0
    ANNUITY::Float64 = 15.0
    RR_LEGAL::Float64 = 0.43
    RR_TARGET::Float64 = 0.70
    SATIATE::Bool = false
    BETA::Float64 = 0.01

    # contribution band, as a fraction of salary
    band_lo::Float64 = 0.02
    band_hi::Float64 = 0.15

    # market designs, kept flat like EvaluateRequest's plan fields
    flat_rate::Float64 = 0.05
    age_rate0::Float64 = 0.03
    age_step::Float64 = 0.01
    age_band::Int = 10

    # numerics
    nF::Int = 73
    nR::Int = 71
    na::Int = 20
    nq::Int = 5
    n_paths::Int = 15_000
    n_seeds::Int = 5              # min-max range over seeds; simulate is ~free
    seed::Int = 7
end

# The DP solve is the whole cost (~2s at 73x71; simulate is ~0.05s), so the grid
# is capped rather than left to the caller — this runs on a home server.
const DYNPRO_MAX = (nF=145, nR=101, na=41, nq=7, n_paths=40_000, n_seeds=10)
# The years each figure shows, taken from the thesis figures they mirror.
const PANEL_YEARS = [1, 5, 10, 20, 25, 30, 40, 44]      # policy_map.png
const MISFUND_YEARS = [0, 10, 22, 44]                   # benchmark_misfunding.png
const SIGNAL_BETAS = [0.0001, 0.001, 0.01, 0.03, 0.10, 0.30]   # signal_schedule.png

# lambda_dial_suite.lambda_threshold: stops at 0.62 because above ~0.6 the optimum is
# pinned at the top of the action grid and the path-weighted curve is a flat line.
const THRESHOLD_LAMBDAS = collect(range(0.15, 0.62; length=16))
# benchmark_suite.FRONTIER_LAMBDAS: the frontier is censored by the band at both ends
# (lambda <= 0.15 at the floor, >= 0.60 at the ceiling), so the points sit in between.
const FRONTIER_LAMBDAS = [0.15, 0.18, 0.21, 0.24, 0.27, 0.30, 0.33, 0.36, 0.39, 0.42,
                          0.45, 0.48, 0.51, 0.54, 0.57, 0.60]
# The sweeps are 32 solves, so they run on the thesis's protocol grid at most
# (common.GRID), whatever the main request asked for.
const SWEEP_MAX = (nF=73, nR=71, na=20, nq=5, n_paths=15_000)

# 1,000,000 episodes runs in ~1s server-side, so there's no real reason to
# undercut basicEnv.py's own default here. A lower value converges fine for
# most parameter combinations, but is not reliable in low-signal regimes —
# e.g. MU ~= G removes the shortfall penalty entirely, leaving only a small
# per-year marginal gap buried in noise from ~44 other years' random
# exploration, which needs the full sample count to resolve (confirmed this
# undercount, not a model bug, by reproducing the same under-converged
# policy in basicEnv.py itself at matching episode counts).
const MAX_EPISODES = 2_000_000

"""Downsample to ~n points so the learning-curve payload stays small."""
function downsample(v::AbstractVector, n::Integer=200)
    length(v) <= n && return collect(v)
    step = length(v) / n
    return [v[clamp(round(Int, i * step) + 1, 1, length(v))] for i in 0:(n - 1)]
end

"""Trailing moving average, same idea as basicEnv.py's plot_results()
(np.convolve(..., mode="valid")) — smooths the raw per-episode reward into
the learning curve that's actually informative to look at."""
function moving_average(v::AbstractVector, window::Integer)
    window = clamp(window, 1, length(v))
    n = length(v) - window + 1
    out = Vector{Float64}(undef, n)
    s = sum(@view v[1:window])
    out[1] = s / window
    for i in 2:n
        s += v[i + window - 1] - v[i - 1]
        out[i] = s / window
    end
    return out
end

"""A matrix as a vector of its rows, so the client's `M[i][j]` is `M[i, j]`.

JSON.jl writes a Matrix column-major — `[1 2; 3 4]` becomes `[[1,3],[2,4]]` — so
sending one as-is hands the browser its TRANSPOSE. On a (near-)square grid that
fails silently: every (F, rho) map was once drawn with the axes swapped."""
rows(M::AbstractMatrix) = [M[i, :] for i in axes(M, 1)]

"""The occupied cells of a visit histogram as `[i, j, count]` (0-based, for the
client), or `[i, j, count, extra[i, j]]`. Careers fill a thin ribbon of the grid,
so this is a few hundred cells where the dense matrix would be ~5,000."""
function occupied(V::AbstractMatrix; extra=nothing)
    out = Vector{Vector{Float64}}()
    for j in axes(V, 2), i in axes(V, 1)
        V[i, j] > 0 || continue
        push!(out, extra === nothing ? [i - 1, j - 1, V[i, j]] :
                                       [i - 1, j - 1, V[i, j], round(extra[i, j], digits=4)])
    end
    return out
end

"""Counts of `v` over `nbins` equal-width bins spanning [lo, hi]."""
function histogram(v::AbstractVector, lo::Real, hi::Real, nbins::Integer=36)
    counts = zeros(Int, nbins)
    width = (hi - lo) / nbins
    width <= 0 && return counts, collect(range(lo, hi; length=nbins + 1))
    for x in v
        isfinite(x) || continue
        k = clamp(floor(Int, (x - lo) / width) + 1, 1, nbins)
        counts[k] += 1
    end
    return counts, collect(range(lo, hi; length=nbins + 1))
end

"""Mean with the min-max range across seeds. The DP solve is the whole cost and
simulate is ~0.05s, so several seeds are nearly free — which is what lets every
simulated number here carry a range instead of pretending to be exact."""
function spread(vals::AbstractVector{<:Real})
    ok = filter(isfinite, vals)
    isempty(ok) && return Dict("value" => nothing, "lo" => nothing, "hi" => nothing)
    return Dict("value" => mean(ok), "lo" => minimum(ok), "hi" => maximum(ok))
end

"""JSON has no NaN literal — JSON.jl throws rather than emit one. evaluate_policy
returns NaN for efficiency/duration when pv_contrib is 0 (e.g. LAMBDA large enough
that never contributing is optimal), so this needs to become `null`, not crash
the response."""
nanToNull(x::Real) = isnan(x) ? nothing : x
nanToNull(x) = x

"""Parse the request body as JSON, keeping only recognized fields and
falling back to the struct's defaults for everything else — unlike Oxygen's
Json{T} extractor, a partial body (the common case here, since each plan type
only sends its own parameters) doesn't error out."""
function parse_request(req, ::Type{T}=EvaluateRequest) where {T}
    fields = fieldnames(T)
    raw = isempty(req.body) ? Dict{String,Any}() : JSON.parse(String(req.body))
    kwargs = (Symbol(k) => v for (k, v) in raw if Symbol(k) in fields)
    return T(; kwargs...)
end

# --- tool registry -----------------------------------------------------
# Single source of truth for the Play Ground overview page — add an entry
# here when a new model gets an interactive page, rather than hand-editing
# the overview's HTML.

const TOOLS = [
    Dict(
        "id" => "pension",
        "title" => "Pension contribution model",
        "description" => "A tabular Monte Carlo control agent decides, year by year, whether it's worth contributing to a pension plan.",
        "href" => "pensionModel.html",
        "tag" => "Reinforcement learning",
    ),
    Dict(
        "id" => "dynpro",
        "title" => "Optimal pension funding (DP oracle)",
        "description" => "Dynamic programming over the funding and salary ratios: what an employer's contribution schedule should look like year by year, against the flat and age-related plans used in practice.",
        "href" => "dynProModel.html",
        "tag" => "Dynamic programming",
    ),
]

# --- routes ---------------------------------------------------------------

@get "/health" function()
    return json(Dict("status" => "ok"))
end

@get "/tools" function()
    return json(Dict("tools" => TOOLS))
end

"""What both DP endpoints share: the parameters, the grids, the band, and the two
market designs as rate-of-salary schedules. `cap` bounds the grid."""
function dynpro_setup(r::DynProRequest; cap=DYNPRO_MAX)
    p = DynPro.Params(T=r.T, G=r.G, MU=r.MU, W=r.W, DISC_EMP=r.DISC_EMP,
                      DISC_ER=r.DISC_ER, SIGMA_R=r.SIGMA_R, SIGMA_L=r.SIGMA_L,
                      GAMMA=r.GAMMA, LAMBDA=r.LAMBDA, ETA=r.ETA, ANNUITY=r.ANNUITY,
                      RR_LEGAL=r.RR_LEGAL, RR_TARGET=r.RR_TARGET,
                      SATIATE=r.SATIATE, BETA=max(r.BETA, 0.0))
    nF = clamp(r.nF, 21, cap.nF)
    nR = clamp(r.nR, 21, cap.nR)
    na = clamp(r.na, 5, cap.na)
    nq = clamp(r.nq, 3, cap.nq)
    n_paths = clamp(r.n_paths, 500, cap.n_paths)
    Fg = make_F_grid(n=nF)
    rg = make_rho_grid(n=nR)
    hi = min(r.band_hi / p.GAMMA, 1.0)
    lo = min(r.band_lo / p.GAMMA, hi)       # GAMMA -> 0 can invert the band
    designs = [("Flat $(round(100 * r.flat_rate, digits=1))% of salary",
                design_flat(r.flat_rate)),
               ("Age scale $(round(100 * r.age_rate0, digits=1))% +$(round(100 * r.age_step, digits=1))%/$(r.age_band)y",
                design_age(r.age_rate0, r.age_step, r.age_band))]
    return (; p, nF, nR, na, nq, n_paths, Fg, rg, lo, hi,
            ag=collect(range(lo, hi; length=na)), designs)
end

"""A design's rate-of-salary schedule as a policy. The design functions return a
RATE OF SALARY; the control is a, with contribution = a * GAMMA * S."""
design_policy(rate_of_t, s) =
    schedule_policy(t -> rate_of_t(t) / s.p.GAMMA, s.nF, s.nR, s.p)

roughness(c_by) = mean(diff(c_by) .^ 2)   # signal_schedule's "mean sq. yr-on-yr change"

function dynpro_evaluate(r::DynProRequest)
    s = dynpro_setup(r)
    p, Fg, rg, n_paths = s.p, s.Fg, s.rg, s.n_paths
    n_seeds = clamp(r.n_seeds, 1, DYNPRO_MAX.n_seeds)

    # One solve serves the optimum AND the signal figure: every temperature in
    # SIGNAL_BETAS is read off the same Q-values (see DynPro.solve's `betas`).
    t_solve = @elapsed out = solve(Fg, rg, s.ag, p; n_quad=s.nq, betas=SIGNAL_BETAS)
    designs = [(name, design_policy(rate, s)) for (name, rate) in s.designs]

    # one solve, several simulates: the range across seeds is the honest error bar
    runs = Dict{String,Vector{Any}}()
    firsts = Dict{String,Any}()
    entry = nothing
    for k in 0:(n_seeds - 1)
        R0, L0, S0 = new_plan_init(n_paths, Xoshiro(r.seed + k))
        k == 0 && (entry = (R0, L0, S0))
        sim(pol; band=nothing) = simulate(pol, Fg, rg, p; R0=R0, L0=L0, S0=S0, band=band,
                                          n_paths=n_paths, seed=r.seed + k, visits=k == 0)
        for (name, pol, band) in [("Optimised (DP)", out.policy, (s.lo, s.hi));
                                  [(nm, pl, nothing) for (nm, pl) in designs]]
            ro = sim(pol; band=band)
            push!(get!(runs, name, []), ro)
            k == 0 && (firsts[name] = ro)
        end
    end

    names = ["Optimised (DP)", designs[1][1], designs[2][1]]
    table = [Dict("name" => nm,
                  (key => spread([x[Symbol(key)] for x in runs[nm]])
                   for key in ("cost", "sty", "lea", "avg", "joint", "benefit"))...)
             for nm in names]
    schedules = [Dict("name" => nm, "c_by" => runs[nm][1][:c_by]) for nm in names]

    opt = firsts["Optimised (DP)"]
    rr, stay = opt[:RR_tot], opt[:stay]
    sty_counts, edges = histogram(rr[stay], p.RR_LEGAL, maximum(rr))
    lea_counts, _ = histogram(rr[.!stay], p.RR_LEGAL, maximum(rr))

    # policy_map.png: the rule at full grid resolution, the cohort's occupancy on it
    V = opt[:visits]
    policy_maps = Dict("F" => Fg, "rho" => rg,
        "maps" => [Dict("year" => y,
                        "a" => rows(round.(out.policy[y + 1], digits=3)),
                        "visits" => occupied(V[y + 1]),
                        "present" => sum(V[y + 1]))
                   for y in PANEL_YEARS if y < p.T])

    # benchmark_misfunding.png: Delta = a_design - a* on the cells the design visits.
    # a* is read OFF-policy there (the design steers the plan elsewhere), which the
    # page states; it is the banded optimum, the one the table simulates.
    star = out.policy
    misfunding = Dict("F" => Fg, "rho" => rg, "designs" => map(designs) do (name, pol)
        Vd = firsts[name][:visits]
        D = [pol[t] .- star[t] for t in 1:p.T]
        tot = sum(sum, Vd)
        over = sum(sum(Vd[t] .* (D[t] .> 0)) for t in 1:p.T)
        Dict("name" => name,
             "over_share" => tot > 0 ? over / tot : nothing,
             "mean_delta" => tot > 0 ? sum(sum(Vd[t] .* D[t]) for t in 1:p.T) / tot : nothing,
             "panels" => [Dict("year" => y,
                               "cells" => occupied(Vd[y + 1]; extra=D[y + 1]),
                               "mean_delta" => sum(Vd[y + 1]) > 0 ?
                                   sum(Vd[y + 1] .* D[y + 1]) / sum(Vd[y + 1]) : nothing)
                          for y in MISFUND_YEARS if y < p.T])
    end)

    # signal_schedule.png: the contribution read off V at each temperature, against
    # the hard argmax, on the first seed's cohort
    R0, L0, S0 = entry
    sig(pol) = simulate(pol, Fg, rg, p; R0=R0, L0=L0, S0=S0, band=(s.lo, s.hi),
                        n_paths=n_paths, seed=r.seed)
    hard = sig(out.policy_hard)
    signal = Dict("beta" => p.BETA,
        "hard" => Dict("c_by" => hard[:c_by], "avg" => hard[:avg],
                       "rough" => roughness(hard[:c_by])),
        "soft" => map(SIGNAL_BETAS) do b
            rs = sig(out.policy_soft[b])
            Dict("beta" => b, "c_by" => rs[:c_by], "avg" => rs[:avg],
                 "rough" => roughness(rs[:c_by]),
                 "gap" => 100 * (hard[:joint] - rs[:joint]) / abs(hard[:joint]))
        end)

    # A band-pinned schedule is set by the constraint, not by the trade-off, and a
    # lambda slider that does nothing reads as broken unless the page says why.
    at_cap = count(>(r.band_hi * 100 - 0.3), opt[:c_by])
    at_floor = count(<(r.band_lo * 100 + 0.3), opt[:c_by])

    return Dict(
        "years" => collect(0:(p.T - 1)),
        "schedules" => schedules,
        "table" => table,
        "adequacy" => Dict("edges" => edges, "stayers" => sty_counts,
                           "leavers" => lea_counts,
                           "target" => p.RR_TARGET, "legal" => p.RR_LEGAL),
        "policy_maps" => policy_maps,
        "misfunding" => misfunding,
        "signal" => signal,
        "meta" => Dict("solve_seconds" => round(t_solve, digits=2),
                       "grid" => Dict("nF" => s.nF, "nR" => s.nR, "na" => s.na, "nq" => s.nq),
                       "n_paths" => n_paths, "n_seeds" => n_seeds,
                       "years_at_cap" => at_cap, "years_at_floor" => at_floor,
                       "band" => [r.band_lo, r.band_hi], "lambda" => p.LAMBDA,
                       # the client draws iso-replacement contours on the policy map
                       "annuity" => p.ANNUITY, "gamma" => p.GAMMA),
    )
end

"""The two lambda sweeps: lambda_dial_suite.lambda_threshold and the frontier of
benchmark_suite.frontier, with the page's two market designs placed against it.

32 independent solves, so they run in parallel on Julia's worker threads (the
Dockerfile passes --threads=auto,1); `Params` is a value, not module state, which
is what makes that safe. Kept out of /dynpro/evaluate so the main result is not held
up behind them: the page requests both and draws each as it lands."""
function dynpro_sweep(r::DynProRequest)
    s = dynpro_setup(r; cap=SWEEP_MAX)
    p, Fg, rg, n_paths = s.p, s.Fg, s.rg, s.n_paths
    R0, L0, S0 = new_plan_init(n_paths, Xoshiro(r.seed))
    sim(pol, q; band=nothing) = simulate(pol, Fg, rg, q; R0=R0, L0=L0, S0=S0, band=band,
                                         n_paths=n_paths, seed=r.seed)
    ag_full = make_a_grid(n=s.na)

    jobs = vcat([(:threshold, l) for l in THRESHOLD_LAMBDAS],
                [(:frontier, l) for l in FRONTIER_LAMBDAS])
    res = Vector{Any}(undef, length(jobs))
    # A pool of all-but-two workers rather than @threads over every thread: the page
    # fires /dynpro/evaluate at the same moment, and with every core taken by the
    # sweep the main result (the one the reader waits on) went from ~4s to ~14s.
    workers = max(1, Threads.nthreads(:default) - 2)
    queue = Channel{Int}(length(jobs))
    foreach(k -> put!(queue, k), eachindex(jobs))
    close(queue)
    run_job(k) = begin
        kind, l = jobs[k]
        q = DynPro.Params(p; LAMBDA=l)
        if kind === :threshold
            # unconstrained, as in the thesis: the band would censor the very rise
            # this figure is about
            pol = solve(Fg, rg, ag_full, q; n_quad=s.nq).policy
            res[k] = (grid_mean=mean(mean, pol), path=sim(pol, q)[:mean_a])
        else
            pol = solve(Fg, rg, s.ag, q; n_quad=s.nq).policy
            m = sim(pol, q; band=(s.lo, s.hi))
            res[k] = (cost=m[:cost], benefit=m[:benefit], sty=m[:sty])
        end
    end
    t_sweep = @elapsed @sync for _ in 1:workers
        Threads.@spawn for k in queue
            run_job(k)
        end
    end
    nt = length(THRESHOLD_LAMBDAS)
    thr, fr = res[1:nt], res[(nt + 1):end]

    # adequacy at matched cost, along the frontier (interpolation CHORDS a concave
    # frontier, so the gap is conservative); none outside the swept range
    o = sortperm([x.cost for x in fr])
    fc, fs = [fr[i].cost for i in o], [fr[i].sty for i in o]
    function at_cost(c)
        (c < fc[1] || c > fc[end]) && return nothing
        k = clamp(searchsortedlast(fc, c), 1, length(fc) - 1)
        w = fc[k + 1] > fc[k] ? (c - fc[k]) / (fc[k + 1] - fc[k]) : 0.0
        return fs[k] + w * (fs[k + 1] - fs[k])
    end
    designs = map(s.designs) do (name, rate)
        m = sim(design_policy(rate, s), p)
        Dict("name" => name, "cost" => m[:cost], "benefit" => m[:benefit],
             "sty" => m[:sty], "dp_sty" => at_cost(m[:cost]))
    end

    return Dict(
        "threshold" => Dict("lambda" => THRESHOLD_LAMBDAS,
                            "grid_mean" => [x.grid_mean for x in thr],
                            "path" => [x.path for x in thr]),
        "frontier" => Dict("lambda" => FRONTIER_LAMBDAS,
                           "cost" => [x.cost for x in fr],
                           "benefit" => [x.benefit for x in fr],
                           "sty" => [x.sty for x in fr]),
        "designs" => designs,
        "meta" => Dict("seconds" => round(t_sweep, digits=2), "threads" => workers,
                       "grid" => Dict("nF" => s.nF, "nR" => s.nR, "na" => s.na, "nq" => s.nq),
                       "lambda" => p.LAMBDA, "target" => p.RR_TARGET, "legal" => p.RR_LEGAL),
    )
end

# Both run on a worker thread, so the server's own thread stays free to accept the
# page's second request while the first is solving.
@post "/dynpro/evaluate" function(req)
    r = parse_request(req, DynProRequest)
    return json(fetch(Threads.@spawn dynpro_evaluate(r)))
end

@post "/dynpro/sweep" function(req)
    r = parse_request(req, DynProRequest)
    return json(fetch(Threads.@spawn dynpro_sweep(r)))
end

@post "/pension/evaluate" function(req)
    r = parse_request(req)
    if r.plan ∉ ("fixed", "step", "age")
        return json(Dict("error" => "unknown plan type: $(r.plan)"); status=400)
    end
    n_episodes = min(r.n_episodes, MAX_EPISODES)

    plan = get_plan(r.plan; rate=r.rate, rate_low=r.rate_low, rate_high=r.rate_high,
                     ceiling=r.ceiling, rate0=r.rate0, step=r.step, band=r.band)

    envkw = (; T=r.T, G=r.G, MU=r.MU, LAMBDA=r.LAMBDA, S0=r.S0, W=r.W, DISC=r.DISC, SIGMA=r.SIGMA)
    batch = draw_shock_batch(r.n_eval, r.T, r.SIGMA; seed=r.seed)

    bench = sweep_benchmark(plan; batch=batch, envkw...)
    gaps, _ = numeric_gap(plan; batch=batch, envkw...)
    result = mc_control(plan; n_episodes=n_episodes, seed=r.seed, envkw...)
    metrics = evaluate_policy(result.policy, plan; envkw...)

    mc_gaps = result.Q[:, 2] .- result.Q[:, 1]
    window = clamp(n_episodes ÷ 50, 10, 2000)
    smoothed = downsample(moving_average(result.reward_trace, window))

    return json(Dict(
        "policy" => result.policy,
        "benchmark_switch" => bench.switch,
        "q_gaps" => gaps,
        "mc_gaps" => mc_gaps,
        "reward_trace" => smoothed,
        "n_episodes" => n_episodes,
        "metrics" => Dict(
            "pv_contrib" => metrics.pv_contrib,
            "pv_payout" => metrics.pv_payout,
            "efficiency" => nanToNull(metrics.efficiency),
            "duration" => nanToNull(metrics.duration),
            "replacement" => metrics.replacement,
        ),
    ))
end

# --- server -----------------------------------------------------------------

# Warm-up. Julia compiles on first call, which made the first request after every
# rebuild take ~23s. Compilation is per TYPE, not per grid size, so one call on a
# tiny grid compiles everything a full-size request needs. It runs in the
# background, so /health answers immediately.
Threads.@spawn try
    tiny = DynProRequest(nF=25, nR=21, na=5, nq=3, n_paths=500, n_seeds=1)
    dynpro_evaluate(tiny)
    dynpro_sweep(tiny)
    JSON.json(dynpro_evaluate(tiny))
    @info "DP endpoints warmed up"
catch err
    @warn "warm-up failed; the first request will compile instead" err
end

allowed_origin = get(ENV, "ALLOWED_ORIGIN", "*")
host = get(ENV, "HOST", "127.0.0.1")
port = parse(Int, get(ENV, "PORT", "8080"))

serve(; host=host, port=port,
      middleware=[Cors(allowed_origins=[allowed_origin])])
