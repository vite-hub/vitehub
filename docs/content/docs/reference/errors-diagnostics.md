---
title: Errors and diagnostics
description: Reference ViteHub error codes and the local proof path for each primitive.
navigation.order: 58
navigation.group: Runtime and output
icon: i-lucide-circle-alert
---

Errors and diagnostics belong to the package that owns the failing boundary. ViteHub exposes one operational error class, `ViteHubError` from `@vite-hub/runtime`; use its namespaced `code` to choose the next proof path.

`ViteHubError` snapshots its public `name`, `code`, `message`, `details`, and `requestId` fields at construction. The snapshot and its details are frozen, `cause` remains private, and later mutation cannot change `toJSON()`. Details must be bounded JSON data without accessors, cycles, `bigint`, non-finite numbers, or class instances; invalid public contracts fail with a fixed `TypeError` instead of serializing the rejected value.

## Code families

| Code prefix | Owner | Usually means |
| --- | --- | --- |
| `CAPABILITY_*` | Runtime Package | Capability lookup or policy failed. |
| `ENV_*` | Env Package | Env Declaration or runtime resolution failed. |
| `BLOB_*` | Blob Package | Blob lookup or Provider-backed storage failed. |
| `KV_*` | KV Package | Provider-backed key-value storage failed. |
| `AUTH_*` and `AUTHENTICATION_*` | Auth Package | Authentication is required or a provider operation failed. HTTP adapters map `AUTHENTICATION_REQUIRED` to `401`. |
| `EMAIL_*` | Email Package | Message validation, configuration, credentials, throttling, network, timeout, or delivery failed. |
| `QUEUE_*`, `CLOUDFLARE_*`, and `VERCEL_*` | Queue Package | Queue dispatch, callback, or Provider handling failed. Queue Delivery owns retry and acknowledgement decisions. |
| `WORKSPACE_*` | Workspace Package | Workspace lookup, path, runtime, store, rule, or file-tree behavior failed. |
| `SOURCE_*` | Source Package | Source lookup, path validation, retrieval, or loader behavior failed. |
| `SCHEDULE_*` | Schedule Package | Static or runtime Schedule behavior failed. |
| `SANDBOX_*` | Sandbox Package | Sandbox Provider setup, execution, or output recovery failed. |
| `WORKFLOW_*` and `OPENWORKFLOW_*` | Workflow Package | Workflow run, step, or Provider behavior failed. |
| Rate Limit policy or driver error | Rate Limit Package | A policy is invalid, the selected driver cannot satisfy its guarantees, a Definition is unknown, or a provider binding is unavailable. |
| `RATE_LIMIT_REJECTED` | Agent Package | Rate Limit Capability rejected an Agent Invocation. |
| `LLM_GATE_REJECTED` | Agent Package | LLM Gate Capability rejected before the main Agent Invocation. |
| `Agent Invocation Stream timed out after <ms>.` | Agent Package | The dev-loop stream aborted a long or stalled Agent Invocation after its timeout. |

## Agent diagnostics

Agent lookup, basic Capability registration, mode validation, and retryable tool-policy failures use [Nostics](https://github.com/vercel-labs/nostics). These errors have a stable `code`, a `message`, a `fix`, and a documentation link. They extend `Error`; catch them by code rather than `TypeError`.

| Code | Action |
| --- | --- |
| `AGENT_NOT_FOUND` | Use a discovered Agent name. The message includes nearby names when available. |
| `AGENT_EXPORT_INVALID`, `AGENT_DEFINITION_INVALID` | Export or pass an Agent Definition created with `defineAgent()`. |
| `AGENT_CAPABILITY_DEFINITION_INVALID`, `AGENT_CAPABILITY_ID_REQUIRED`, `AGENT_CAPABILITY_ID_INVALID` | Supply a Capability object with a valid id. |
| `AGENT_TRIGGER_NAME_REQUIRED`, `AGENT_TRIGGER_NAME_INVALID` | Supply a trigger name that starts with a letter and uses letters, numbers, hyphens, or underscores. |
| `AGENT_CAPABILITY_MODE_INVALID` | Set mode to `read` or `write`. |
| `AGENT_CAPABILITIES_INVALID`, `AGENT_CAPABILITY_DUPLICATE` | Supply an ordered array with unique Capability ids. |
| `AGENT_EXTENSION_NOT_COMPILED` | Load Eve extensions through the ViteHub Agent Vite plugin. |
| `AGENT_CAPABILITY_DYNAMIC_UNSUPPORTED` | Move definition-time contributions to a static Capabilities array. |
| `AGENT_TOOL_POLICY_RETRYABLE` | Retry when the policy permits execution. |

Application tools can use their own Nostics catalog:

```ts
import { defineDiagnostics } from 'nostics'

const errors = defineDiagnostics({
  codes: {
    SEARCH_INDEX_MISSING: {
      why: 'Search index is missing.',
      fix: 'Create the search index before searching.',
    },
  },
})

throw errors.SEARCH_INDEX_MISSING()
```

Install `nostics` as a direct dependency when using it in application code. Omit reporters for throw-only catalogs. ViteHub formats the error where it is reported.

AI SDK tool results, Codex and Claude Code MCP tool responses, tool-step reports, and CLI error output retain the code and repair guidance. Formatting omits causes and stacks. Only put information suitable for the model in the diagnostic message, fix, sources, and docs. The AI SDK adapter wraps a Nostics tool failure in an `Error` with the formatted message because the SDK reads only `error.message`; the original diagnostic remains its `cause`.

`normalizeRuntimeDiagnosticError(error)` preserves Nostics metadata in bounded diagnostic records, including serialized Nostics errors. `formatRuntimeDiagnosticError(error)` from `@vite-hub/runtime` formats those records for text output. Sources share the node limit, and all strings share the size limit. Large error records can omit metadata when these limits are reached.

Public HTTP error mapping, approval decisions, and cancellation keep their existing contracts. A Nostics diagnostic does not become a public `ViteHubError`. Unknown public failures still map to `INTERNAL`.

## Agent public errors

Agent routes and hooks expose a sanitized `AgentPublicError` beside the original
server error. It is safe to serialize to a caller or use in an application-owned
reply:

```ts
interface AgentPublicError {
  code: AgentPublicErrorCode
  error: string
  details?: {
    capability?: string
    category?: string
    retryAfter?: number
  }
  requestId?: string
}
```

`agent:error` hooks receive the raw failure as `error` and the sanitized value as
`publicError`. Chat error hooks receive the same pair. Keep the raw error in
protected diagnostics; provider payloads and causes can contain credentials or
private response data.

| Public code | Meaning |
| --- | --- |
| `PROVIDER_AUTHENTICATION_FAILED` | The model provider rejected its credentials. |
| `PROVIDER_QUOTA_EXHAUSTED` | The account or project has no remaining provider quota. |
| `PROVIDER_RATE_LIMITED` | The provider returned a temporary rate limit. |
| `PROVIDER_UNAVAILABLE` | The provider returned a server or availability failure. |
| `APPROVAL_REQUIRED` | A Capability needs approval before it can continue. `requestId` identifies the approval request when available. |
| `AUTHENTICATION_REQUIRED`, `RATE_LIMIT_*`, `LLM_GATE_REJECTED`, `CAPABILITY_*`, `TRANSCRIPTION_*` | ViteHub recognized a public application or Capability failure. |
| `INTERNAL` | The failure has no approved public mapping. The message stays generic. |

The mapper includes only bounded identifiers, categories, retry delays, and
request IDs. It replaces unknown errors with a context-specific `INTERNAL`
message instead of copying `error.message`.

## Diagnostics sources

| Source | Use |
| --- | --- |
| CLI exit code and stderr | Command parsing, provisioning, and Agent Eval failures. |
| Env diagnostics | Missing, defaulted, valid, and masked Env Declaration status. |
| Generated files | Discovery, Runtime Registry, and Provider Output inspection. |
| Agent Dev Loop responses | Local Agent inspection and invocation failures. |
| Trace Events | Runtime policy, approval, capability, lifecycle, and error records. |
| Package tests | Contract failures owned by the primitive package. |

## Local response

Start with `getViteHubErrorShape(error)?.code`, then inspect the owning package and failing proof path. For packages that generate Provider Output, inspect that output before changing runtime code. Authenticated Agent bridges distinguish `AUTHENTICATION_REQUIRED` from `AUTH_PROVIDER_OPERATION_FAILED`; use `details.operation` for safe diagnostics and `cause` only in protected server-side diagnostics. Email emits no Provider Output; inspect the `EMAIL_*` code and `details.driver`.

For Env, inspect the `ENV_*` code first. Its code set and public messages are fixed. `ENV_DECLARATION_INVALID` can include `details.path`, `ENV_REQUIRED_MISSING` can include a bounded source identifier and declaration path, and `ENV_RUNTIME_VALUE_INVALID` and `ENV_SOURCE_FAILED` can include a bounded source identifier such as `env`, `git:branch`, `package.json`, or `custom`. Raw labels and diagnostics remain in `cause`, which the serialized shape omits. Custom source resolvers keep application-owned errors unchanged.

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

Keep secrets out of production diagnostics.
Use Server Env and Secret Env for runtime secret values, and rely on package diagnostics to redact known secret values where supported.

## Related

- [Troubleshooting](/docs/development/troubleshooting)
- [Runtime events](/docs/reference/runtime-events)
- [Verification](/docs/development/verification)
