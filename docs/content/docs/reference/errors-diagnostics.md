---
title: Errors and diagnostics
description: Reference common ViteHub error families and the local proof path for each one.
navigation.order: 56
icon: i-lucide-circle-alert
---

Errors and diagnostics belong to the package that owns the failing boundary.
Use the error family to choose the next proof path before changing implementation code.

## Error families

| Error | Owner | Usually means |
| --- | --- | --- |
| `CapabilityNotFoundError` | Runtime Package | A Runtime Capability handle is missing. |
| `CapabilityDeniedError` | Runtime Package | Runtime policy denied a capability operation. |
| `ApprovalRequiredError` | Runtime Package | A policy decision requires an Approval Request before execution. |
| `EnvError` | Env Package | Env Declaration or runtime resolution failed with an Env-owned code and JSON-safe context. |
| `AuthenticationRequiredError` | Auth Package | A route or Agent Invoker bridge needs an authenticated application user; inspect code `AUTHENTICATION_REQUIRED` and `statusCode: 401`. |
| `AuthenticationProviderError` | Auth Package | The default Better Auth request or session operation failed; inspect code `AUTH_PROVIDER_OPERATION_FAILED` and safe operation details. |
| `EmailError` | Email Package | A structured Email validation, configuration, or provider delivery failure with a stable code and safe details. |
| `QueueError` | Queue Package | Queue dispatch, callback, or provider handling failed. |
| `WorkspaceError` | Workspace Package | Workspace runtime, store, rule, or file-tree behavior failed. |
| `WorkspaceNotFoundError` | Workspace Package | The requested Workspace is not registered. |
| `WorkspacePathError` | Workspace Package | A Workspace path is invalid or outside allowed shape. |
| `SourceError` | Source Package | Source retrieval or Source Loader behavior failed. |
| `SourceNotFoundError` | Source Package | The requested Source key or Source Path is missing. |
| `SourcePathError` | Source Package | A Source Path is invalid. |
| `ScheduleError` | Schedule Package | Static or runtime schedule behavior failed. |
| `SandboxError` | Sandbox Package | Sandbox Provider setup, execution, or output recovery failed. |
| `NotSupportedError` | Sandbox shared runtime | A selected provider or operation is unsupported. |
| `WorkflowError` | Workflow Package | Workflow run, step, or provider behavior failed. |
| Rate Limit policy or driver error | Rate Limit Package | A policy is invalid, the selected driver cannot satisfy its guarantees, a Definition is unknown, or a provider binding is unavailable. |
| `RateLimitRejectedError` | Agent Package | Rate Limit Capability rejected an Agent Invocation. |
| `LlmGateRejectedError` | Agent Package | LLM Gate Capability rejected before the main Agent Invocation. |
| `Agent Invocation Stream timed out after <ms>.` | Agent Package | The dev-loop stream aborted a long or stalled Agent Invocation after its timeout. |

## Diagnostics sources

| Source | Use |
| --- | --- |
| CLI exit code and stderr | Command parsing, provisioning, and Agent Eval failures. |
| Env diagnostics | Missing, defaulted, valid, and masked Env Declaration status. |
| Generated files | Discovery, Runtime Registry, and Provider Output inspection. |
| DevTools Bridge responses | Interactive Agent and Workspace inspection failures. |
| Trace Events | Runtime policy, approval, capability, lifecycle, and error records. |
| Package tests | Contract failures owned by the primitive package. |

## Local response

Start with the owning package and the failing proof path. For packages that generate Provider Output, inspect that output before changing runtime code. Authenticated Agent bridges expose `AuthenticationRequiredError.code` and `statusCode`; default Better Auth operational failures use `AuthenticationProviderError`, and both error families keep their cause in memory only. Email emits no Provider Output; inspect `EmailError.toJSON()` or its `code` and `driver`, then use `cause` only in protected server-side diagnostics because serialization deliberately excludes it.

For Env, inspect `EnvError.code` first. `ENV_DECLARATION_INVALID` includes `details.path`, `ENV_REQUIRED_MISSING` includes the public source label and sometimes the declaration path, `ENV_RUNTIME_VALUE_INVALID` includes the public source label, and `ENV_SOURCE_FAILED` identifies a failed built-in Git or package metadata source through `details.source`. The serialized shape omits `cause`; never place secret values in `details`.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
find .vitehub -maxdepth 4 -type f | sort
pnpm --filter @vite-hub/sandbox test
```

### Rate Limit diagnostics

| Symptom | Likely cause | Verify |
| --- | --- | --- |
| Duplicate Rate Limit ID | Multiple `defineRateLimit()` calls use the same stable ID. | Follow both reported source locations and rename one declaration. |
| Driver provides best-effort enforcement | A policy requires `strict`, but the selected provider cannot guarantee it. | Keep strict enforcement and choose another driver, or change the policy only when best-effort protection is acceptable. |
| Driver does not support the window | The provider accepts fewer fixed-window periods than the portable policy type. | Use a supported period or select a driver that advertises the required window. |
| Production hosting requires an explicit provider | The build target is unknown or has no native inferred Rate Limit provider. | Set `provider: 'cloudflare'` with a project-unique `namespace` for Cloudflare, set `provider: 'memory'` only for a deliberate single-process deployment, or construct a custom Rate Limiter. |
| Cloudflare binding was not found | Generated `ratelimits` output is missing from the running Worker or request context. | Inspect `wrangler.json`, then exercise the deployed Worker rather than an unrelated Node process. |
| `reason: 'unavailable'` with `allowed: true` | A `failure: 'allow'` policy allowed work after a driver error. | Record the unavailable decision and inspect provider health before changing the budget. |

## Production response

Production diagnostics should avoid leaking secrets.
Use Server Env and Secret Env for runtime secret values, and rely on package diagnostics to redact known secret values where supported.

## Related

- [Troubleshooting](/docs/development/troubleshooting)
- [Runtime events](/docs/reference/runtime-events)
- [Verification](/docs/development/verification)
