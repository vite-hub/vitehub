---
title: Provider status
description: Check provider sign-in and subscription quota without running an Agent.
navigation.title: Provider status
navigation.order: 53
navigation.group: Inspect and evaluate
navigation.kind: Reference
---

`status(context, { abortSignal })` on an Agent Definition tells you if its provider is signed in and has quota. The built-in Codex and Claude Code Drivers (model runners) reuse T3's account and quota probes. A check starts no Agent Invocation, prompt, or conversation.

The Console shows status on Usage, from the `status.get` operation of the Console endpoint. The optional `agent` input picks one Agent Definition. Console access rules protect it in production, also with a custom base path. Status works when `console.invoke` is off. Running tasks still needs that opt-in.

## Read the result

A result has `agent`, `provider`, `checkedAt`, `stale`, `installed`, `authenticated`, `readiness`, and optional subscription `usageLimits`. When the provider gives authoritative evidence, it also has `modelCompatibility` for the configured model and `workspaceCapacity` for workspace or project spending capacity. Quota windows hold percentages and reset times, not money costs.

Each check is:

- `ready`: the executable, authentication, and available quota passed.
- `unavailable`: an executable is missing, authentication failed, the provider returned an error, or a quota window is used up.
- `unknown`: readiness is not clear. This includes a quota, model compatibility, or workspace capacity check that is unsupported or failed.
- `unsupported`: the Driver has no account inspection.

Readiness holds at `checkedAt` only, not for later requests. A clear incompatible-model or workspace-capacity signal makes readiness `unavailable`, and invocation preflight rejects before capability preparation or checkout. Missing evidence stays `unknown` and does not claim the dimension is available.

## Caching

- The Console shares concurrent probes per Agent Definition, caches results for 30 seconds, and aborts probes after 15 seconds.
- A failed refresh keeps the previous evidence with `stale: true` and `readiness: "unknown"`.
- The built-in Drivers also keep each result for 30 seconds per Agent Definition. They group results by credential source when `driver.credentials` is set, else by host account. A preflight in that window reuses it.

A check uses the same Driver credentials, credential profile, environment, and launcher as an invocation. Provider resolvers get `purpose: "inspection"` and no invoker or mounted Workspace. Resolvers that need those fields must handle their absence. A custom launcher gets a temporary working directory and no tool environment requirements. The probe releases credential and launcher files after the probe exits.

Console status responses never include raw provider diagnostics, account emails, or credentials. Liveness endpoints belong to your app.
