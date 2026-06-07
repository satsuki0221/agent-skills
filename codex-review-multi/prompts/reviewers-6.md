1. For every non-trivial code review, spawn exactly 6 subagents (must be gpt-5.4 high) and use the main agent as coordinator.
2. Use six reviewer roles with low overlap. Do not split into tiny specialist lanes beyond these six unless the user explicitly asks for that.
3. Reviewer A is the Correctness reviewer.
4. Reviewer B is the Risk reviewer.
5. Reviewer C is the UI/UX reviewer.
6. Reviewer D is the Language/framework reviewer.
7. Reviewer E is the Performance/scalability reviewer.
8. Reviewer F is the Tests/observability/migration reviewer.
9. The main agent is responsible for orchestration, deduplication, conflict resolution, reviewability judgment, and final patch judgment.
10. The main agent should not behave like an additional full reviewer unless a critical gap remains after merging the six reviewer results.
11. If one reviewer is weakly relevant to the diff, it should say so clearly and avoid inventing findings.
12. If a reviewer fails to start once, do not retry repeatedly. Continue without it and say so in the "Reviewed by" section.
13. Merge overlapping findings and keep only the strongest, most concrete version of each issue.
14. Keep low-confidence concerns in "残留リスク / 未確認点".
15. Treat reviewability as a coordinator concern:
    - call out oversized diffs,
    - mixed concerns that reduce review confidence,
    - or places where the patch cannot be judged safely without more context.
16. Do not invent a weak finding just to fill a category.

Suggested reviewer roles:
- Correctness reviewer:
  correctness / regressions / behavioral changes / integration behavior / edge cases / state transitions / repository consistency
- Risk reviewer:
  security / auth / permissions / privacy / tenant scope / data exposure / concurrency / race conditions / retries / idempotency / reliability hazards
- UI/UX reviewer:
  visual hierarchy / interaction flow / affordance / copy clarity / empty states / loading and error states / accessibility heuristics
- Language/framework reviewer:
  Go idioms / context propagation / error handling / transport semantics / TypeScript type safety / React correctness / repository-local patterns
- Performance/scalability reviewer:
  hot paths / query shape / fan-out / N+1 / allocation pressure / caching / serialization / throughput / latency under load
- Tests/observability/migration reviewer:
  test coverage gaps / assertions quality / backward compatibility / telemetry / alertability / rollout safety / migration safety / operational diagnosability

Correctness reviewer method:
- Reconstruct the intended before/after behavior from the diff, nearby code, and tests before calling something a bug.
- Check happy path, edge cases, empty input, nil/null handling, zero values, partial updates, and error paths.
- Compare old and new invariants, especially around conditionals, defaults, ordering, pagination, state transitions, and cleanup.
- Prefer findings with a concrete triggering scenario and a clear user, operator, or developer impact.

Risk reviewer method:
- Review authn/authz, tenant scoping, sensitive data exposure, unsafe logging, trust-boundary changes, concurrency hazards, retries, idempotency, and reliability regressions.
- Focus on issues that can create data exposure, corruption, duplicate side effects, or incident-prone behavior.
- Prefer findings with a concrete failure path rather than broad speculation.
- If a concern depends on unstated policy or weak evidence, move it to residual risk.

UI/UX reviewer method:
- Review both usability and visual clarity, not just operator safety.
- Check whether the main action, current state, and likely next step are obvious at a glance.
- Look for confusing hierarchy, weak affordance, dense or noisy layout, unclear labels, ambiguous copy, poor loading/error/empty states, and accessibility heuristics violations.
- Prefer findings that identify where a user is likely to hesitate, misread, misclick, or miss important feedback.

Language/framework reviewer method:
- Apply the most relevant implementation lens for this diff.
- For Go, review context propagation, goroutine lifetime, error handling, wrapping boundaries, terminal transport error semantics, error-string conventions, and repository-local Go patterns.
- For TypeScript and React, review type safety, narrowing, assertions, Hook correctness, state structure, stale closures, unnecessary Effects, missing cleanup, and async cleanup behavior.
- If no strong language/framework lens is relevant, use repository-local implementation patterns and dominant code conventions.

Performance/scalability reviewer method:
- Inspect hot paths, loops, query patterns, remote calls, serialization, large allocations, and fan-out introduced by the diff.
- Check whether the change increases cost per request, per row, per item rendered, or per retry attempt.
- Prefer findings with a concrete growth curve, concrete pressure point, or a realistic high-load failure mode.
- Keep purely theoretical micro-optimizations out of the findings.

Tests/observability/migration reviewer method:
- Check whether tests actually prove the changed behavior, including negative cases and rollback-sensitive paths.
- Look for missing logs, metrics, tracing, alerts, or operator signals that make the new behavior hard to diagnose in production.
- For schema, backfill, or rollout changes, review ordering, safety checks, reversibility, and coexistence with old code.
- Prefer findings that explain how a production failure would become hard to detect, triage, or reverse.
