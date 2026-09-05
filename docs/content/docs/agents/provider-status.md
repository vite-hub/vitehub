---
title: Provider status
description: Inspect provider authentication and subscription quota without running an Agent.
---

Agent Definitions expose `status(context, { abortSignal })` for provider inspection. Built-in Codex and Claude Code Drivers reuse T3's account and quota probes. Inspection does not create an Agent Invocation, send a model prompt, or open a conversation.

The Console shows this evidence on Usage and exposes it through its authenticated `status` RPC operation and `GET /api/_vitehub/console/status`. The optional `agent` query selects a discovered Agent Definition. Console access rules protect this endpoint in production, including when the application uses a custom base path. Inspection remains available when `console.invoke` is disabled; task execution still requires its explicit opt-in.

A result includes `agent`, `provider`, `checkedAt`, `stale`, `installed`, `authenticated`, `readiness`, and optional subscription `usageLimits`. Quota windows contain percentages and reset times. They are separate from monetary usage costs.

- `ready` means the executable, authentication, and available quota evidence passed inspection.
- `unavailable` means an executable is missing, authentication failed, the provider reported an error, or a quota window is exhausted.
- `unknown` means inspection could not establish readiness, including when quota is unsupported or its probe failed.
- `unsupported` means the Driver does not implement account inspection.

Readiness is evidence at `checkedAt`, not a guarantee that a later model request succeeds. Console shares concurrent probes for each Agent Definition, caches results for 30 seconds, and aborts probes after 15 seconds. A failed refresh preserves previous evidence with `stale: true` and `readiness: "unknown"`.

Inspection resolves the same Driver credentials, credential profile, environment, and launcher as invocations. Provider resolvers receive `purpose: "inspection"` and no actor, invoker, or mounted Workspace. Resolvers that need those invocation fields must handle their absence. A custom launcher receives a temporary working directory and no tool environment requirements. Credential files and launcher files are released after the probe exits.

Raw provider diagnostics, account emails, and credentials are excluded from Console status responses. Operational liveness endpoints remain application-owned.
