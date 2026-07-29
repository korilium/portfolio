using Oxygen
using JSON

include(joinpath(@__DIR__, "models", "pension.jl"))
using .Pension

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

"""JSON has no NaN literal — JSON.jl throws rather than emit one. evaluate_policy
returns NaN for efficiency/duration when pv_contrib is 0 (e.g. LAMBDA large enough
that never contributing is optimal), so this needs to become `null`, not crash
the response."""
nanToNull(x::Real) = isnan(x) ? nothing : x
nanToNull(x) = x

const REQUEST_FIELDS = fieldnames(EvaluateRequest)

"""Parse the request body as JSON, keeping only recognized fields and
falling back to EvaluateRequest's defaults for everything else — unlike
Oxygen's Json{T} extractor, a partial body (the common case here, since
each plan type only sends its own parameters) doesn't error out."""
function parse_request(req)
    raw = isempty(req.body) ? Dict{String,Any}() : JSON.parse(String(req.body))
    kwargs = (Symbol(k) => v for (k, v) in raw if Symbol(k) in REQUEST_FIELDS)
    return EvaluateRequest(; kwargs...)
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
]

# --- routes ---------------------------------------------------------------

@get "/health" function()
    return json(Dict("status" => "ok"))
end

@get "/tools" function()
    return json(Dict("tools" => TOOLS))
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
