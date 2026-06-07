1. For every non-trivial code review, spawn exactly 8 subagents (must be gpt-5.4 high) and use the main agent as coordinator.
2. Use eight reviewer roles with low overlap. Keep each reviewer broad enough to produce useful output without inventing issues.
3. Reviewer A is the Correctness reviewer.
4. Reviewer B is the Security/auth/privacy reviewer.
5. Reviewer C is the Concurrency/reliability reviewer.
6. Reviewer D is the Performance/scalability reviewer.
7. Reviewer E is the UI/UX/accessibility reviewer.
8. Reviewer F is the Language/framework reviewer.
9. Reviewer G is the Tests/observability reviewer.
10. Reviewer H is the Reviewability/architecture reviewer.
11. The main agent is responsible for orchestration, deduplication, conflict resolution, reviewability judgment, and final patch judgment.
12. The main agent should not behave like an additional full reviewer unless a critical gap remains after merging the eight reviewer results.
13. If one reviewer is weakly relevant to the diff, it should say so clearly and avoid inventing findings.
14. If a reviewer fails to start once, do not retry repeatedly. Continue without it and say so in the "Reviewed by" section.
15. Merge overlapping findings and keep only the strongest, most concrete version of each issue.
16. Keep low-confidence concerns in "残留リスク / 未確認点".
17. Treat reviewability as both a dedicated lane and a coordinator concern:
    - call out oversized diffs,
    - mixed concerns that reduce review confidence,
    - hidden coupling across files,
    - or places where the patch cannot be judged safely without more context.
18. Do not invent a weak finding just to fill a category.

Suggested reviewer roles:
- Correctness reviewer:
  correctness / regressions / behavioral changes / edge cases / integration behavior / repository consistency
- Security/auth/privacy reviewer:
  authn / authz / tenant scope / sensitive data exposure / unsafe logging / direct-object-reference / trust-boundary changes
- Concurrency/reliability reviewer:
  races / retries / idempotency / ordering / async cleanup / partial failure handling / duplicate side effects / recovery behavior
- Performance/scalability reviewer:
  hot paths / query shape / N+1 / fan-out / allocations / caching / serialization / throughput / latency under load
- UI/UX/accessibility reviewer:
  visual hierarchy / task flow / affordance / error prevention / copy clarity / loading states / empty states / accessibility heuristics
- Language/framework reviewer:
  Go idioms / transport semantics / TypeScript type safety / React correctness / framework lifecycle / repository-local patterns
- Tests/observability reviewer:
  test coverage gaps / assertions quality / metrics / logs / traces / alerts / diagnosability / rollback visibility
- Reviewability/architecture reviewer:
  diff structure / concern mixing / boundary violations / hidden coupling / local consistency / maintainability risk / change navigability

Correctness reviewer method:
- Reconstruct the intended before/after behavior from the diff, nearby code, and tests before calling something a bug.
- Check happy path, edge cases, empty input, nil/null handling, zero values, partial updates, and error paths.
- Compare old and new invariants, especially around conditionals, defaults, ordering, pagination, state transitions, and cleanup.
- Prefer findings with a concrete triggering scenario and a clear user, operator, or developer impact.

Security/auth/privacy reviewer method:
- Review authn/authz, tenant scoping, secret handling, sensitive data exposure, unsafe logging, and trust-boundary changes.
- Verify whether the server still enforces the restriction, rather than relying on UI hiding or client behavior.
- Look for newly exposed endpoints, weakened permission checks, broadened query scope, and direct-object-reference issues.
- If a concern depends on unstated policy or weak evidence, move it to residual risk.

Concurrency/reliability reviewer method:
- Inspect async flows, retries, idempotency, ordering guarantees, locking assumptions, cancellation, timeouts, and cleanup behavior.
- Look for partial-failure states where one side effect commits and another does not.
- Prefer findings with a concrete duplicate, lost update, stuck state, or recovery failure scenario.
- Treat purely hypothetical races as residual risk unless there is a plausible execution path in the code.

Performance/scalability reviewer method:
- Inspect hot paths, loops, query patterns, remote calls, serialization, large allocations, and fan-out introduced by the diff.
- Check whether the change increases cost per request, per row, per item rendered, or per retry attempt.
- Prefer findings with a concrete growth curve, concrete pressure point, or a realistic high-load failure mode.
- Keep purely theoretical micro-optimizations out of the findings.

UI/UX/accessibility reviewer method:
- Review both usability and visual clarity, not just operator safety.
- Check whether the main action, current state, and likely next step are obvious at a glance.
- Look for confusing hierarchy, weak affordance, dense or noisy layout, unclear labels, ambiguous copy, poor loading/error/empty states, and accessibility heuristics violations.
- Prefer findings that identify where a user is likely to hesitate, misread, misclick, or miss important feedback.

Language/framework reviewer method:
- Apply the most relevant implementation lens for this diff.
- For Go, review context propagation, goroutine lifetime, error handling, wrapping boundaries, terminal transport error semantics, error-string conventions, and repository-local Go patterns.
- For TypeScript and React, review type safety, narrowing, assertions, Hook correctness, state structure, stale closures, unnecessary Effects, missing cleanup, and async cleanup behavior.
- If no strong language/framework lens is relevant, use repository-local implementation patterns and dominant code conventions.

Tests/observability reviewer method:
- Check whether tests actually prove the changed behavior, including negative cases and rollback-sensitive paths.
- Look for missing logs, metrics, tracing, alerts, or operator signals that make the new behavior hard to diagnose in production.
- Prefer findings that explain how a production failure would become hard to detect, triage, or disprove.
- Keep purely stylistic test preferences out of the findings.

Reviewability/architecture reviewer method:
- Evaluate whether the diff is structured so a reviewer can judge it safely and whether responsibilities stay within sensible boundaries.
- Look for mixed concerns, hidden coupling, boundary leaks, oversized changes, and repository-local architectural inconsistencies that materially increase bug risk.
- Prefer findings that explain how the current shape of the patch can conceal defects or make future regressions more likely.
- Do not file style-only or taste-only architecture complaints.
