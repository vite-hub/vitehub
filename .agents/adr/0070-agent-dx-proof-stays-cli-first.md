# ADR 0070: Agent DX Proof Stays CLI-First

## Status

Accepted.

## Context

Recent Agent Package work added harness-backed evals, capability finish metadata, invocation traces, and local dev-loop proof surfaces.
The Eve comparison made the next attractive direction clear: agent workflows need inspectable command-line entry points before they need dashboards or implicit project conventions.

## Decision

Keep near-term Agent DX proof CLI-first and JSON-friendly.
Prefer explicit surfaces such as Agent Eval Runner output, Agent Dev Loop target attachment, future Agent Surface Inspection, and URL-backed agent proof over hosted dashboards or hidden discovery.

Public docs should describe only implemented contracts.
Unimplemented ideas belong in `.agents` language and ADRs until the CLI/runtime supports them.

## Consequences

- Eval and dev-loop docs must explain the current timeout, target, driver, capability, and observability boundaries.
- Capability docs should show eval-visible finish metadata and Workspace contributions because those are supported today.
- Future work should add `agent info --json`, URL-backed Agent Eval targets, and remote Agent Dev targets as explicit CLI features instead of special-purpose downstream scripts.
