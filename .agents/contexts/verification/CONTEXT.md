# Verification

Verification names how the workspace proves that ViteHub primitives keep working: from offline assertions on generated artifacts to scheduled runs against real providers.

## Language

**Primitive Suite**:
The single per-package set of e2e assertions for one primitive, written once and executed against any target URL.
_Avoid_: Live test, local test, smoke script, per-tier test copy

**Provider Output Contract**:
An offline PR-gating assertion on the shape of generated Provider Output, such as bundle purity, bindings, crons, and emitted function files.
_Avoid_: Artifact check, purity script, YAML assertion

**Local Provider Run**:
A PR-gating execution of built Provider Output on a local runtime so Primitive Suites run without touching a cloud account.
_Avoid_: Emulator test, mock deploy, dev server test

**Live Smoke**:
A scheduled, intentionally thin execution of Primitive Suites against a real provider deployment.
_Avoid_: Manual e2e, full regression, live test matrix

**Downstream Escape**:
A primitive defect first observed in a project outside this workspace.
_Avoid_: User bug report, demo issue, flake

## Relationships

- A **Primitive Suite** is the only place primitive e2e assertions live; **Local Provider Run** and **Live Smoke** execute the same suite against different targets.
- A **Provider Output Contract** asserts Provider Output (see Framework Integrations) without executing it.
- A **Local Provider Run** executes the same Provider Output that a **Live Smoke** deploys; fidelity gaps between them must be explicit, not silent.
- **Provider Output Contracts** and **Local Provider Runs** gate pull requests; **Live Smoke** runs on a schedule.
- Depth belongs to **Provider Output Contracts**, **Local Provider Runs**, and unit tests; **Live Smoke** stays thin by design.
- A **Downstream Escape** is reproduced in a **Primitive Suite** or the playground together with its fix, so coverage grows exactly where reality proved it thin.

## Example Dialogue

> **Dev:** "The live e2e is failing, should I add more assertions to it?"
> **Domain expert:** "No. Add them to the **Primitive Suite** so every tier gains them; **Live Smoke** stays thin."
>
> **Dev:** "Can I assert the wrangler.json shape inside the live workflow YAML?"
> **Domain expert:** "No. That is a **Provider Output Contract**; it lives in a versioned test file and gates pull requests."

## Flagged Ambiguities

- "e2e" was used for the manual live workflow, per-package scripts, and artifact assertions interchangeably - resolved: split into **Provider Output Contract**, **Local Provider Run**, and **Live Smoke**, all sharing **Primitive Suites**.
