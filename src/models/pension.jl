module Pension

using Random
using Statistics

export plan_fixed, plan_step, plan_age, get_plan,
       run_episode, run_batch, draw_shock_batch,
       mc_control, evaluate_policy,
       sweep_benchmark, gap_benchmark, numeric_gap,
       check_batch_consistency

"""
Julia port of the tabular Monte Carlo control pension toy from
https://github.com/korilium/KuLeuven-Thesis-Second-Pillar-Pension-Optimisation-for-Belgian-Employers-via-Deep-RL
(toyEnv/basicEnv.py). Same recursions, same defaults — years are 0-indexed
(t = 0..T-1) to match the source, with arrays offset by one for Julia's
1-indexing.
"""

# --- plan rules: c(t, S) -> premium ---------------------------------------

plan_fixed(rate::Real=0.05) = (t, S) -> rate * S

function plan_step(rate_low::Real=0.04, rate_high::Real=0.10, ceiling::Real=1.5)
    return (t, S) -> rate_low * min(S, ceiling) + rate_high * max(S - ceiling, 0.0)
end

function plan_age(rate0::Real=0.03, step::Real=0.01, band::Integer=10)
    return (t, S) -> (rate0 + step * (t ÷ band)) * S
end

function get_plan(name::AbstractString; rate=0.05, rate_low=0.04, rate_high=0.10,
                   ceiling=1.5, rate0=0.03, step=0.01, band=10)
    name == "fixed" && return plan_fixed(rate)
    name == "step"  && return plan_step(rate_low, rate_high, ceiling)
    name == "age"   && return plan_age(rate0, step, band)
    error("unknown plan type: $name")
end

# --- stochastic paths -------------------------------------------------------

function draw_shock_batch(n_paths::Integer, T::Integer, SIGMA::Real; seed::Integer=12345)
    SIGMA == 0.0 && return nothing
    return randn(Xoshiro(seed), n_paths, T)
end

# --- single-episode and vectorized recursions ------------------------------

function run_episode(choose_action, plan, shocks=nothing;
                      T::Integer=45, G::Real=0.0175, MU::Real=0.01, KAPPA::Real=0.5,
                      S0::Real=1.0, W::Real=0.025, DISC::Real=0.01, SIGMA::Real=0.05)
    R = 0.0
    L = 0.0
    S = S0
    actions = Vector{Int}(undef, T)
    rewards = zeros(Float64, T)
    for t in 0:(T - 1)
        a = choose_action(t)
        actions[t + 1] = a
        c = plan(t, S) * a
        rewards[t + 1] = -KAPPA * c * exp(-DISC * t)
        z = shocks === nothing ? 0.0 : shocks[t + 1]
        R = (R + c) * exp(MU + SIGMA * z)
        L = (L + c) * exp(G)
        S *= (1.0 + W)
    end
    payout = max(R, L)
    shortfall = max(L - R, 0.0)
    rewards[end] += (payout - KAPPA * shortfall) * exp(-DISC * T)
    return actions, rewards
end

"""All paths at once for a FIXED policy (length-T 0/1 vector).
shocks: (n_paths, T). Returns a values vector of length n_paths."""
function run_batch(policy::AbstractVector, plan, shocks::AbstractMatrix;
                    T::Integer=45, G::Real=0.0175, MU::Real=0.01, KAPPA::Real=0.5,
                    S0::Real=1.0, W::Real=0.025, DISC::Real=0.01, SIGMA::Real=0.05)
    n = size(shocks, 1)
    R = zeros(Float64, n)
    L = 0.0
    S = S0
    values = zeros(Float64, n)
    for t in 0:(T - 1)
        c = plan(t, S) * policy[t + 1]
        values .-= KAPPA * c * exp(-DISC * t)
        @views R .= (R .+ c) .* exp.(MU .+ SIGMA .* shocks[:, t + 1])
        L = (L + c) * exp(G)
        S *= (1.0 + W)
    end
    payout = max.(R, L)
    shortfall = max.(L .- R, 0.0)
    values .+= (payout .- KAPPA .* shortfall) .* exp(-DISC * T)
    return values
end

function policy_value(policy_fn, plan, batch;
                       T::Integer=45, kwargs...)
    if batch === nothing
        _, r = run_episode(policy_fn, plan; T=T, kwargs...)
        return sum(r), 0.0
    end
    policy = [policy_fn(t) for t in 0:(T - 1)]
    vals = run_batch(policy, plan, batch; T=T, kwargs...)
    return mean(vals), std(vals; corrected=true) / sqrt(length(vals))
end

# --- Monte Carlo control ----------------------------------------------------

function mc_control(plan; T::Integer=45, n_episodes::Integer=100_000, seed::Integer=0,
                     epsStart::Real=1.0, epsEnd::Real=0.05, decay_frac::Real=0.25,
                     burn_in::Integer=30_000, n0::Real=500, ALPHA::Real=0.02,
                     G::Real=0.0175, MU::Real=0.01, KAPPA::Real=0.5, S0::Real=1.0,
                     W::Real=0.025, DISC::Real=0.01, SIGMA::Real=0.05)
    rng = Xoshiro(seed)
    reward_trace = Vector{Float64}(undef, n_episodes)
    decay_episodes = max(1, Int(floor(decay_frac * n_episodes)))

    Q = zeros(Float64, T, 2)
    N = zeros(Float64, T, 2)

    envkw = (; T, G, MU, KAPPA, S0, W, DISC, SIGMA)

    for ep in 0:(n_episodes - 1)
        frac = min(ep / decay_episodes, 1.0)
        eps = epsStart + (epsEnd - epsStart) * frac

        # Anchor the averaging window on restart without discarding Q — see
        # basicEnv.py's mc_control docstring for why N is reset to n0, not 0.
        if ep == decay_episodes || ep == decay_episodes + burn_in
            fill!(N, n0)
        end

        choose_action(t) = rand(rng) < eps ? rand(rng, 0:1) : argmax(view(Q, t + 1, :)) - 1

        shocks = SIGMA > 0 ? randn(rng, T) : nothing
        actions, rewards = run_episode(choose_action, plan, shocks; envkw...)
        reward_trace[ep + 1] = sum(rewards)
        returns = reverse(cumsum(reverse(rewards)))

        for t in 0:(T - 1)
            a = actions[t + 1]
            if frac < 1.0
                Q[t + 1, a + 1] += ALPHA * (returns[t + 1] - Q[t + 1, a + 1])
            else
                N[t + 1, a + 1] += 1
                Q[t + 1, a + 1] += (returns[t + 1] - Q[t + 1, a + 1]) / N[t + 1, a + 1]
            end
        end
    end

    policy = [argmax(view(Q, t, :)) - 1 for t in 1:T]
    return (plan=plan, Q=Q, policy=policy, reward_trace=reward_trace)
end

# --- benchmarks (no learning) ----------------------------------------------

function sweep_benchmark(plan; batch=nothing, T::Integer=45, n_grid::Integer=T + 1, kwargs...)
    best_switch = 0
    best_value = -Inf
    for k in 0:(n_grid - 1)
        value, _ = policy_value(t -> Int(t < k), plan, batch; T=T, kwargs...)
        if value > best_value
            best_switch, best_value = k, value
        end
    end
    return (switch=best_switch, value=best_value)
end

"""Per-year marginal value of contributing (CRN-paired at the stochastic
rung). With SIGMA > 0 the max() terminal breaks linearity, so this is a
diagnostic, not a certificate — matches basicEnv.py's numeric_gap."""
function numeric_gap(plan; batch=nothing, T::Integer=45, kwargs...)
    v_none, _ = policy_value(t -> 0, plan, batch; T=T, kwargs...)
    gaps = zeros(Float64, T)
    ses = zeros(Float64, T)
    if batch === nothing
        for k in 0:(T - 1)
            v_k, _ = policy_value(t -> Int(t == k), plan, batch; T=T, kwargs...)
            gaps[k + 1] = v_k - v_none
        end
    else
        vals0 = run_batch(zeros(Int, T), plan, batch; T=T, kwargs...)
        for k in 0:(T - 1)
            pol_k = zeros(Int, T)
            pol_k[k + 1] = 1
            diffs = run_batch(pol_k, plan, batch; T=T, kwargs...) .- vals0
            gaps[k + 1] = mean(diffs)
            ses[k + 1] = std(diffs; corrected=true) / sqrt(length(diffs))
        end
    end
    return gaps, ses
end

"""Certified-optimal policy under linearity, with a self-check against the
whole-vs-sum-of-parts identity — matches basicEnv.py's gap_benchmark."""
function gap_benchmark(plan; batch=nothing, T::Integer=45, kwargs...)
    gaps, ses = numeric_gap(plan; batch=batch, T=T, kwargs...)
    _, r_none = run_episode(t -> 0, plan; T=T, kwargs...)
    policy = Int.(gaps .> 0)

    value_parts = sum(r_none) + sum(gaps[gaps .> 0])
    _, r_star = run_episode(t -> policy[t + 1], plan; T=T, kwargs...)
    value_whole = sum(r_star)
    linear = abs(value_whole - value_parts) < 1e-10

    return (linear=linear, value=value_whole, value_parts=value_parts,
            value_none=sum(r_none), policy=policy, gaps=gaps)
end

"""run_batch must agree with run_episode path-by-path — matches
basicEnv.py's check_batch_consistency."""
function check_batch_consistency(plan; T::Integer=45, n_check::Integer=5, seed::Integer=99, kwargs...)
    rng = Xoshiro(seed)
    shocks = randn(rng, n_check, T)
    policy = rand(rng, 0:1, T)
    vec = run_batch(policy, plan, shocks; T=T, kwargs...)
    for i in 1:n_check
        _, r = run_episode(t -> policy[t + 1], plan, view(shocks, i, :); T=T, kwargs...)
        @assert abs(vec[i] - sum(r)) < 1e-10 "path $i: $(vec[i]) vs $(sum(r))"
    end
    return true
end

# --- unscaled economics of a fixed policy -----------------------------------

function evaluate_policy(policy::AbstractVector, plan;
                          T::Integer=45, G::Real=0.0175, MU::Real=0.01,
                          S0::Real=1.0, W::Real=0.025, DISC::Real=0.01, kwargs...)
    R = 0.0
    L = 0.0
    S = S0
    pv_contrib = 0.0
    t_weighted = 0.0
    for t in 0:(T - 1)
        c = plan(t, S) * policy[t + 1]
        d = c * exp(-DISC * t)
        pv_contrib += d
        t_weighted += t * d
        R = (R + c) * exp(MU)
        L = (L + c) * exp(G)
        S *= (1.0 + W)
    end
    payout = max(R, L)
    pv_payout = payout * exp(-DISC * T)
    return (
        pv_contrib=pv_contrib,
        pv_payout=pv_payout,
        efficiency=pv_contrib > 0 ? pv_payout / pv_contrib : NaN,
        duration=pv_contrib > 0 ? t_weighted / pv_contrib : NaN,
        replacement=payout / (S0 * (1.0 + W)^(T - 1)),
    )
end

end # module
