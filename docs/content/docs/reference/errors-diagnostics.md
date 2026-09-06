---
title: Errors and diagnostics
description: Reference ViteHub error codes and the local proof path for each primitive.
navigation.order: 58
navigation.group: Runtime and output
icon: i-lucide-circle-alert
---

Each package owns the errors from its public API, configuration, build integration, generated output, and runtime boundary. ViteHub-owned developer defects use [Nostics](https://github.com/vercel-labs/nostics). A diagnostic is an `Error` with a stable `code`, a message, and optional repair guidance, source locations, and documentation.

## Diagnostic codes

Diagnostic codes use this format:

| Format | Catalog group |
| --- | --- |
| `<PACKAGE>_C####` | Configuration and API-specific diagnostics |
| `<PACKAGE>_B####` | Build, discovery, and generated-output-specific diagnostics |
| `<PACKAGE>_R####` | General package diagnostics |

The package prefix identifies the owner, for example `AGENT`, `AUTH`, `BLOB`, `DATABASE`, `ENV`, `KV`, `RATE_LIMIT`, `SANDBOX`, or `WORKSPACE`. The family letter groups the package catalog. It does not classify when the failure can occur because one validation site can run during configuration, build, or runtime work. The number identifies one failure site. Codes stay stable when a message gains context. Catch a diagnostic by its complete `code` when the application can repair or classify that exact defect.

```ts
import { getAgentFromRegistry } from '@vite-hub/agent'

try {
  await getAgentFromRegistry('triage', {})
}
catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'AGENT_R0001') {
    // Use a discovered Agent name.
  }
  throw error
}
```

When ViteHub wraps a lower-level failure, its `cause` remains available to protected in-process diagnostics. ViteHub preserves existing `DOMException`, `AggregateError`, cancellation errors, and application or third-party errors when their identity is part of the boundary contract.

Some code runs where the Nostics package cannot load. Browser page evaluation, uploaded Sandbox scripts, standalone Deno deploy runners, and test helpers can use native errors inside their isolated environment. The owning package translates or sanitizes those failures when they cross back into the ViteHub process.

## Operational errors

Expected portable failures keep the `ViteHubError` contract from `@vite-hub/runtime`. Examples include authentication requirements, provider operation failures, missing Blob values, Queue delivery failures, and policy rejections. These semantic codes describe an application result instead of a developer defect.

`ViteHubError` snapshots its public `name`, `code`, `message`, `details`, and `requestId` fields at construction. The snapshot and its details are frozen. Its `cause` stays on the in-memory error and `toJSON()` omits it. Public details must be bounded JSON data.

Use the operational code to choose application behavior. Use a Nostics code to locate and repair ViteHub configuration, build, or runtime code.

## Agent diagnostics

Agent configuration, build, and runtime defects use the `AGENT_C####`, `AGENT_B####`, and `AGENT_R####` families. Application tools can use their own Nostics catalog:

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

Public HTTP error mapping, approval decisions, and cancellation keep their existing contracts. A Nostics diagnostic does not become a public `ViteHubError`. Unknown public failures still map to `INTERNAL`. Public HTTP responses never serialize causes or stacks.

### Migrate existing error checks

Replace native `TypeError` and `RangeError` checks for ViteHub-owned defects with the diagnostic code. Application and third-party errors retain their own contracts. The initial Agent catalog uses these replacement codes:

| Previous code | Current code |
| --- | --- |
| `AGENT_NOT_FOUND` | `AGENT_R0001` |
| `AGENT_EXPORT_INVALID` | `AGENT_R0002` |
| `AGENT_DEFINITION_INVALID` | `AGENT_C0001` |
| `AGENT_CAPABILITY_DEFINITION_INVALID` | `AGENT_C0002` |
| `AGENT_CAPABILITY_ID_REQUIRED` | `AGENT_C0003` |
| `AGENT_CAPABILITY_ID_INVALID` | `AGENT_C0004` |
| `AGENT_TRIGGER_NAME_REQUIRED` | `AGENT_C0005` |
| `AGENT_TRIGGER_NAME_INVALID` | `AGENT_C0006` |
| `AGENT_CAPABILITY_MODE_INVALID` | `AGENT_C0007` |
| `AGENT_CAPABILITIES_INVALID` | `AGENT_C0008` |
| `AGENT_EXTENSION_NOT_COMPILED` | `AGENT_B0001` |
| `AGENT_CAPABILITY_DUPLICATE` | `AGENT_C0009` |
| `AGENT_CAPABILITY_DYNAMIC_UNSUPPORTED` | `AGENT_C0010` |
| `AGENT_TOOL_POLICY_RETRYABLE` | `AGENT_R0003` |

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

Start with the error's `code`. A numeric Nostics code identifies the owning package and failure site. A semantic operational code can be read with `getViteHubErrorShape(error)?.code`. For packages that generate Provider Output, inspect that output before changing runtime code. Authenticated Agent bridges distinguish `AUTHENTICATION_REQUIRED` from `AUTH_PROVIDER_OPERATION_FAILED`; use `details.operation` for safe diagnostics and `cause` only in protected server-side diagnostics. Email emits no Provider Output; inspect the `EMAIL_*` code and `details.driver`.

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
