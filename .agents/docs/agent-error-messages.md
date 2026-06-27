# Agent Error Messages

This note records the inferred `grill-with-docs` outcome for Agent Invocation error handling.

## Decision

ViteHub normalizes unknown thrown values at the Agent Invocation boundary and exposes a stable **Agent Error Message** to Agent Finish Hooks.

Keep the original thrown value available as `event.error`. Expose the normalized message as `event.errorMessage`. Do not make Result, Effect, or a Result-style dependency part of this boundary.

## Inferred Questions

**Should ViteHub require Agent code to throw only `Error` objects?**
Recommended answer: no. JavaScript can throw any value, and user code, provider code, streams, and Capabilities can all fail with unknown values. ViteHub should normalize at its own boundary.

**Should the Agent Finish Hook receive a Result-style value instead of thrown failure state?**
Recommended answer: no. The Agent Invocation Lifecycle already reports success or failure through the finish event. Result shapes are useful for recoverable domain workflows, not for this lifecycle observation seam.

**Should ViteHub add Effect TS for this?**
Recommended answer: no. Effect is an architecture choice, not an error-message fix.

**Should ViteHub add a small Result dependency such as better-result, neverthrow, true-myth, or unthrow?**
Recommended answer: no. Those libraries still need unknown-error normalization at the boundary. A local helper is smaller and clearer.

**Should ViteHub expose structured error details?**
Recommended answer: not yet. `event.error` preserves the original value for advanced consumers. `event.errorMessage` covers the common reporting path without freezing stack/name/detail semantics into public API.

## General Pattern

When ViteHub catches unknown failures at package-owned public boundaries:

- preserve the original unknown value when the API already exposes raw failure state;
- expose one stable message field when users need to report or log the failure;
- keep HTTP/public response messages separate from internal diagnostic messages;
- avoid dependency-level Result systems unless the public API intentionally models recoverable failures as values.

## Evidence

Research artifacts:

- `/var/folders/85/68jgd5r148j98t_nq6w1r5mh0000gn/T/evidence-research/vitehub/agent-error-message-result-pattern/synthesis.md`
- `/var/folders/85/68jgd5r148j98t_nq6w1r5mh0000gn/T/validate-direction/vitehub/agent-error-message-contract/verdict.md`
