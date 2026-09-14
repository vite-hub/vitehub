# Simplicity lens

Review for complexity that does not earn its cost. Prefer the smallest design that fully satisfies the spec, repository standards, clarity, and operability. Treat line count as evidence, never as the target.

Check in order:

1. Delete behavior, dead flexibility, and scaffolding the spec does not require.
2. Reuse an existing repository primitive or pattern.
3. Prefer the standard library, native platform, or an installed dependency over custom machinery.
4. Inline abstractions, configuration, and delegation layers with only one concrete use.
5. Shrink verbose logic only when the replacement is at least as clear and preserves every relevant behavior.

Classify each justified simplification as `delete`, `reuse`, `stdlib`, `native`, `inline`, or `shrink`. Keep it to one complete line when the mechanism, consequence, and replacement remain clear; otherwise use the normal Engineering finding format.

Preserve required validation, error handling, security, accessibility, tests, and genuine domain boundaries. Route correctness, security, and performance defects through the normal review instead of disguising them as simplification. Do not score line reduction or issue a merge verdict. When no cut is justified, report `No simplicity findings.`
