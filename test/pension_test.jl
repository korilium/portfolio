using Test

include(joinpath(@__DIR__, "..", "src", "models", "pension.jl"))
using .Pension

"""
Acceptance bar ported from basicEnv.py's own validation (its docstring:
"No closed forms: the benchmark evaluates the environment directly").
Run with: julia --project=. test/pension_test.jl
"""

@testset "Pension model port" begin
    for plan in (plan_fixed(), plan_step(), plan_age())
        @testset "run_batch matches run_episode path-by-path" begin
            @test check_batch_consistency(plan)
        end

        @testset "deterministic gap_benchmark is internally consistent" begin
            gb = gap_benchmark(plan; SIGMA=0.0)
            @test gb.linear
            @test isapprox(gb.value, gb.value_parts; atol=1e-8)
        end

        @testset "MC control learns the deterministic benchmark switch on decided years" begin
            bench = sweep_benchmark(plan; SIGMA=0.0)
            gaps, _ = numeric_gap(plan; SIGMA=0.0)
            result = mc_control(plan; n_episodes=1_000_000, SIGMA=0.0)

            # "decided" years: |marginal gap| well above tabular MC noise floor
            decided = abs.(gaps) .> 0.01
            bench_policy = Int.((0:44) .< bench.switch)
            @test result.policy[decided] == bench_policy[decided]
        end
    end
end
