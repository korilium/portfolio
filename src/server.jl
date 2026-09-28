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
const DYNPRO_YEARS = [0, 10, 22, 44]   # the years whose policy maps are returned

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

"""Thin a matrix to at most `n` rows and columns by taking every k-th node —
the policy map is 73x71 and only needs to be legible, not exact, in the browser.
n = 28 keeps the eight heatmaps to ~6k SVG rects; at 40 the rendered markup was
750 KB, which is a lot of DOM to hand a phone for a picture that coarse."""
function thin(M::AbstractMatrix, n::Integer=28)
    ri = 1:max(1, cld(size(M, 1), n)):size(M, 1)
    ci = 1:max(1, cld(size(M, 2), n)):size(M, 2)
    return collect(ri), collect(ci), [M[i, j] for i in ri, j in ci]
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

@post "/dynpro/evaluate" function(req)
    r = parse_request(req, DynProRequest)

    p = DynPro.Params(T=r.T, G=r.G, MU=r.MU, W=r.W, DISC_EMP=r.DISC_EMP,
                      DISC_ER=r.DISC_ER, SIGMA_R=r.SIGMA_R, SIGMA_L=r.SIGMA_L,
                      GAMMA=r.GAMMA, LAMBDA=r.LAMBDA, ETA=r.ETA, ANNUITY=r.ANNUITY,
                      RR_LEGAL=r.RR_LEGAL, RR_TARGET=r.RR_TARGET,
                      SATIATE=r.SATIATE, BETA=r.BETA)

    nF = clamp(r.nF, 21, DYNPRO_MAX.nF)
    nR = clamp(r.nR, 21, DYNPRO_MAX.nR)
    na = clamp(r.na, 5, DYNPRO_MAX.na)
    nq = clamp(r.nq, 3, DYNPRO_MAX.nq)
    n_paths = clamp(r.n_paths, 500, DYNPRO_MAX.n_paths)
    n_seeds = clamp(r.n_seeds, 1, DYNPRO_MAX.n_seeds)

    Fg = make_F_grid(n=nF)
    rg = make_rho_grid(n=nR)
    lo = r.band_lo / p.GAMMA
    hi = min(r.band_hi / p.GAMMA, 1.0)
    lo = min(lo, hi)                       # GAMMA -> 0 can invert the band
    ag = collect(range(lo, hi; length=na))

    t_solve = @elapsed out = solve(Fg, rg, ag, p; n_quad=nq)

    # The design functions return a RATE OF SALARY; schedule_policy wants the control
    # a, and contribution = a * GAMMA * S — so every design divides through by GAMMA.
    as_control(rate_of_t) = t -> rate_of_t(t) / p.GAMMA
    age_rate = design_age(r.age_rate0, r.age_step, r.age_band)
    designs = [("Flat $(round(100 * r.flat_rate, digits=1))% of salary",
                schedule_policy(as_control(design_flat(r.flat_rate)), nF, nR, p)),
               ("Age scale $(round(100 * r.age_rate0, digits=1))% +$(round(100 * r.age_step, digits=1))%/$(r.age_band)y",
                schedule_policy(as_control(age_rate), nF, nR, p))]

    # one solve, several simulates: the range across seeds is the honest error bar
    runs = Dict{String,Vector{Any}}()
    first_opt = nothing
    for k in 0:(n_seeds - 1)
        rng = Xoshiro(r.seed + k)
        R0, L0, S0 = new_plan_init(n_paths, rng)
        want = k == 0
        ro = simulate(out.policy, Fg, rg, p; R0=R0, L0=L0, S0=S0, band=(lo, hi),
                      n_paths=n_paths, seed=r.seed + k, visits=want)
        push!(get!(runs, "Optimised (DP)", []), ro)
        k == 0 && (first_opt = ro)
        for (name, pol) in designs
            push!(get!(runs, name, []),
                  simulate(pol, Fg, rg, p; R0=R0, L0=L0, S0=S0,
                           n_paths=n_paths, seed=r.seed + k))
        end
    end

    names = ["Optimised (DP)", designs[1][1], designs[2][1]]
    table = [Dict("name" => nm,
                  "cost" => spread([x[:cost] for x in runs[nm]]),
                  "sty" => spread([x[:sty] for x in runs[nm]]),
                  "lea" => spread([x[:lea] for x in runs[nm]]),
                  "avg" => spread([x[:avg] for x in runs[nm]]),
                  "joint" => spread([x[:joint] for x in runs[nm]])) for nm in names]

    schedules = [Dict("name" => nm, "c_by" => runs[nm][1][:c_by]) for nm in names]

    rr = first_opt[:RR_tot]
    stay = first_opt[:stay]
    hi_rr = maximum(rr)
    sty_counts, edges = histogram(rr[stay], p.RR_LEGAL, hi_rr)
    lea_counts, _ = histogram(rr[.!stay], p.RR_LEGAL, hi_rr)

    years = [y for y in DYNPRO_YEARS if y <= p.T - 1]
    fi, rj, _ = thin(out.policy[1])
    maps = [Dict("year" => y, "a" => thin(out.policy[y + 1])[3],
                 "visits" => thin(first_opt[:visits][y + 1])[3]) for y in years]

    # A band-pinned schedule is set by the constraint, not by the trade-off, and a
    # lambda slider that does nothing reads as broken unless the page says why.
    at_cap = count(>(r.band_hi * 100 - 0.3), first_opt[:c_by])
    at_floor = count(<(r.band_lo * 100 + 0.3), first_opt[:c_by])

    return json(Dict(
        "years" => collect(0:(p.T - 1)),
        "schedules" => schedules,
        "table" => table,
        "adequacy" => Dict("edges" => edges, "stayers" => sty_counts,
                           "leavers" => lea_counts,
                           "target" => p.RR_TARGET, "legal" => p.RR_LEGAL),
        "policy_maps" => Dict("F" => Fg[fi], "rho" => rg[rj], "maps" => maps),
        "meta" => Dict("solve_seconds" => round(t_solve, digits=2),
                       "grid" => Dict("nF" => nF, "nR" => nR, "na" => na, "nq" => nq),
                       "n_paths" => n_paths, "n_seeds" => n_seeds,
                       "years_at_cap" => at_cap, "years_at_floor" => at_floor,
                       "band" => [r.band_lo, r.band_hi]),
    ))
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

allowed_origin = get(ENV, "ALLOWED_ORIGIN", "*")
host = get(ENV, "HOST", "127.0.0.1")
port = parse(Int, get(ENV, "PORT", "8080"))

serve(; host=host, port=port,
      middleware=[Cors(allowed_origins=[allowed_origin])])
