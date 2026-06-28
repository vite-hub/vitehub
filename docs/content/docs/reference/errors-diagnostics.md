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
| `EnvError` | Env Package | Env Declaration resolution, validation, or diagnostics failed. |
| `AuthenticationRequiredError` | Auth Package | A route or Agent Invoker bridge needs an authenticated application user. |
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

Start with the owning package and the failing proof path.
For provider failures, inspect generated output before changing runtime code.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
find .vitehub -maxdepth 4 -type f | sort
pnpm --filter @vite-hub/sandbox test
```

## Production response

Production diagnostics should avoid leaking secrets.
Use Server Env and Secret Env for runtime secret values, and rely on package diagnostics to redact known secret values where supported.

## Related

- [Troubleshooting](/docs/development/troubleshooting)
- [Runtime events](/docs/reference/runtime-events)
- [Verification](/docs/development/verification)
