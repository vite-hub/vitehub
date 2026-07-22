---
title: Errors and diagnostics
description: Reference common ViteHub error families and the local proof path for each one.
navigation.order: 56
icon: i-lucide-circle-alert
---

Errors and diagnostics belong to the package that owns the failing boundary.
Use the error family to choose the next proof path before changing implementation code.

Errors built on `ViteHubError` snapshot their public `code`, `message`, `details`, `requestId`, and `retryable` fields at construction. The snapshot and its details are frozen, `cause` remains private, and later mutation cannot change `toJSON()`. Details must be bounded JSON data without accessors, cycles, `bigint`, non-finite numbers, or class instances; invalid public contracts fail with a fixed `TypeError` instead of serializing the rejected value. This intentionally breaks callers that relied on mutating an error after construction or passed non-JSON detail objects.

## Error families

| Error | Owner | Usually means |
| --- | --- | --- |
| `CapabilityNotFoundError` | Runtime Package | A Runtime Capability handle is missing. |
| `CapabilityDeniedError` | Runtime Package | Runtime policy denied a capability operation. |
| `ApprovalRequiredError` | Runtime Package | A policy decision requires an Approval Request before execution. |
| `EnvError` | Env Package | Env Declaration or runtime resolution failed with an Env-owned code and JSON-safe context. |
| `AuthenticationRequiredError` | Auth Package | A route or Agent Invoker bridge needs an authenticated application user; inspect code `AUTHENTICATION_REQUIRED` and `statusCode: 401`. |
| `AuthenticationProviderError` | Auth Package | A default Better Auth request or session operation failed; inspect code `AUTH_PROVIDER_OPERATION_FAILED` and the safe operation details. |
| `EmailError` | Email Package | Message validation, missing Email Definition, delivery credentials, throttling, network, timeout, or provider delivery failed. |
| `QueueError` | Queue Package | Queue dispatch, callback, provider handling, or a structured Queue Delivery failed. `retryable: false` on a custom Queue error acknowledges the reported delivery unless an explicit provider callback directive overrides it; ViteHub owns retry policy for built-in failures. |
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
| Agent Dev Loop responses | Local Agent inspection and invocation failures. |
| Trace Events | Runtime policy, approval, capability, lifecycle, and error records. |
| Package tests | Contract failures owned by the primitive package. |

### Schedule errors

`ScheduleError` requires a stable `ScheduleErrorCode` when constructed. Its JSON form contains only `code`, `details`, `message`, `requestId`, and `retryable`; server-only fields such as `cause`, `stack`, and the `httpStatus` transport hint are not serialized. Validation failures describe the invalid field and value type without including the value itself.

## Local response

Start with the owning package and the failing proof path. For packages that generate Provider Output, inspect that output before changing runtime code. Authenticated Agent bridges distinguish a missing session with `AuthenticationRequiredError` from a default provider failure with `AuthenticationProviderError`; use `details.operation` for safe diagnostics and `cause` only in protected server-side diagnostics. Email emits no Provider Output; inspect `EmailError.code` and `driver` the same way.

For Env, inspect `EnvError.code` first. Its code set and public messages are fixed. `ENV_DECLARATION_INVALID` can include `details.path`, `ENV_REQUIRED_MISSING` can include a bounded source identifier and declaration path, and `ENV_RUNTIME_VALUE_INVALID` and `ENV_SOURCE_FAILED` can include a bounded source identifier such as `env`, `git:branch`, `package.json`, or `custom`. Raw labels and diagnostics remain in `cause`, which the serialized shape omits. Custom source resolvers keep application-owned errors unchanged.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
find .vitehub -maxdepth 4 -type f | sort
pnpm --filter @vite-hub/sandbox test
```

### Rate Limit diagnostics

| Symptom | Likely cause | Verify |
| --- | --- | --- |
| Conflicting Rate Limit policy | Multiple `requireRateLimit()` calls use the same stable ID with different static policies. | Follow both reported source locations and make the policies identical or rename one ID. |
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
