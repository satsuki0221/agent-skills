1. For every non-trivial code review, spawn exactly 4 subagents (must be gpt-5.4 high) and use the main agent as coordinator.
2. Do not create one reviewer per narrow angle. Use four broad, low-overlap reviewer roles.
3. Reviewer A is the Correctness reviewer.
4. Reviewer B is the Risk reviewer.
5. Reviewer C is the UI/UX reviewer.
6. Reviewer D is the Language/framework reviewer.
7. The main agent is responsible for orchestration, deduplication, conflict resolution, reviewability judgment, and final patch judgment.
8. The main agent should not behave like a fifth full reviewer unless a critical gap remains after merging the four reviewer results.
9. If one reviewer is weakly relevant to the diff, it should say so clearly and avoid inventing findings.
10. If a reviewer fails to start once, do not retry repeatedly. Continue without it and say so in the "Reviewed by" section.
11. Merge overlapping findings and keep only the strongest, most concrete version of each issue.
12. Keep low-confidence concerns in "残留リスク / 未確認点".
13. Treat reviewability as a coordinator concern:
    - call out oversized diffs,
    - mixed concerns that reduce review confidence,
    - or places where the patch cannot be judged safely without more context.
14. Do not invent a weak finding just to fill a category.

Suggested reviewer roles:
- Correctness reviewer:
  correctness / regressions / behavioral changes / integration behavior / edge cases / tests / repository consistency
- Risk reviewer:
  security / auth / permissions / privacy / tenant scope / data exposure / performance / scalability / hot paths / query shape / concurrency / race conditions / retries / idempotency / migration safety / observability
- UI/UX reviewer:
  visual hierarchy / layout clarity / interaction flow / affordance / error prevention / copy clarity / system status / accessibility heuristics / information density / readability / empty states / loading and error states
- Language/framework reviewer:
  Go idioms / context propagation / error handling / transport semantics / TypeScript type safety / React correctness / repository-local implementation patterns

Correctness reviewer method:
- Reconstruct the intended before/after behavior from the diff, nearby code, and tests before calling something a bug.
- Check happy path, edge cases, empty input, nil/null handling, zero values, partial updates, and error paths.
- Compare old and new invariants, especially around conditionals, defaults, ordering, pagination, state transitions, and cleanup.
- Treat repository consistency as part of maintainability and correctness risk, not as a separate review lane.
- Prefer findings with a concrete triggering scenario and a clear user, operator, or developer impact.

Risk reviewer method:
- Review the diff for security, privacy, authorization, tenant scoping, sensitive data exposure, unsafe logging, performance regressions, concurrency hazards, retry safety, idempotency, migration safety, and observability gaps.
- Focus on issues that can create data exposure, corruption, reliability degradation, or operational instability.
- Prefer findings with a concrete failure mode, concrete load implication, or concrete risk path.
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
