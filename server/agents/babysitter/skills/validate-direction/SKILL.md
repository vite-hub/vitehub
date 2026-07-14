---
name: validate-direction
description: Validates whether a proposed change fits ViteHub's philosophy and improves the affected experience. Use before Babysitter implements or finalizes a bug fix, developer-experience change, API change, refactor, or operational change.
---

# Validate Direction

Decide whether the proposed direction is worth implementing. This skill owns only that decision.

Inspect only. Return the verdict to the caller, which owns any changes.

## Steps

1. **Understand the change.** Read the pull request intent, diff, repository instructions, and surrounding code and documentation. State the problem, affected user, experience before and after, and proposed ownership boundary. This step is complete when one sentence explains why the change should exist.

2. **Recover the philosophy.** Inspect the relevant `git log`, `git show`, and `git blame`. Derive ViteHub's principles from existing primitives, naming, defaults, documentation, and earlier decisions. Look for similar or reverted approaches and intentional constraints. This step is complete when every claimed principle or constraint has repository evidence.

3. **Challenge the direction.** Form the strongest credible objection. Check whether a bug fix addresses the cause at the owning layer, whether DX and API work creates a simpler and discoverable workflow, and whether refactors or operational changes preserve their invariants. Prefer an existing ViteHub primitive when it provides the intended experience. This step is complete when evidence resolves the objection or exposes a decision-changing unknown.

4. **Return one verdict.** Choose:
   - `proceed` when the direction is coherent;
   - `revise` when one concrete correction makes it coherent;
   - `pause` when an unanswered question could reverse it.

```text
Verdict: proceed|revise|pause
Direction: <problem, user, outcome, and boundary>
Evidence: <current behavior and causal evidence>
Philosophy: <relevant ViteHub precedent>
Challenge: <strongest objection and result>
Correction: <only for revise>
Unknown: <only for pause>
Next: <one concrete action>
```
