---
title: Errors and diagnostics
description: ViteHub error codes, what they mean, and how to find and fix the cause.
navigation.order: 58
navigation.group: Runtime and output
icon: i-lucide-circle-alert
---

Each package owns its own errors. ViteHub errors use [Nostics](https://github.com/vercel-labs/nostics): a diagnostic is an `Error` with a stable `code`, a `why`, a `fix`, and a `docs` link.

## The error contract

All ViteHub primitives are moving to one contract. A package that follows it lists its codes on its `limits-and-errors` page.

- A runtime operation returns `[error, data]`. It does not throw for a failure the caller can handle.
- `error` has `code`, `why`, `fix`, `docs`, and `cause`. The type of `error.code` is the union of the codes the operation can return.
- Definition and config errors throw at build time, define time, or when an operation starts. A retry cannot help: the code or the deployment must change.
- An error before a stream starts is in the tuple. A later error goes into the stream.
- `JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`. It never includes `cause`, `stack`, `sources`, or diagnostic `data`.

```ts
import { kv } from 'vite-hub/kv'

const [error, settings] = await kv.get('settings')
if (error) {
  error.code // 'KV_OPERATION_FAILED'
  error.why // 'kv.get() failed on the "default" store.'
  error.fix // 'Read `error.cause` for the provider error. ...'
  error.docs // 'https://vitehub.dev/docs/kv/diagnostics/kv_operation_failed'
}
```

`Result<T, Code>` and `ResultError<Code>` from `vite-hub/runtime` type this tuple. Packages define their codes with `defineErrors()` from `vite-hub/runtime`. Each code has a `why`, a `fix`, and a page in the diagnostics of its primitive, such as [KV diagnostics](/docs/kv/diagnostics). `error.docs` opens that page. [All diagnostics](/docs/reference/diagnostics) lists every primitive.

A catalog code can give static or computed `data`, which stays in memory. Each factory infers its data type. `ResultError<Code, Data>` names it; without it, `data` is `unknown`. The `toJSON()` type keeps the literal code and name and matches Nostics `Diagnostic`, so `formatDiagnostic()` accepts catalog errors. Nostics 1.3 requires `data` in its serializer type, but runtime JSON still omits it. Read `data` from the error itself.

## Diagnostic codes

New codes use names: `<PACKAGE>_<NAME>`, such as `KV_INVALID_CURSOR` or `EMAIL_RATE_LIMITED`. Codes that a package published with a number keep it:

| Format | Catalog group |
| --- | --- |
| `<PACKAGE>_C####` | Configuration and API |
| `<PACKAGE>_B####` | Build, discovery, and generated output |
| `<PACKAGE>_R####` | General |

- The prefix names the owner package, such as `AGENT`, `AUTH`, `BLOB`, `DATABASE`, `ENV`, `KV`, `RATE_LIMIT`, `SANDBOX`, `SANDBOX_TASK`, or `WORKSPACE`.
- The letter only groups the catalog. It does not say when the failure happens: one check can run at config, build, or runtime.
- The number marks one failure site. The code does not change when its message does.

Catch a diagnostic by its full `code` when your app can fix or classify that exact defect.

```ts
import { loadAgent } from 'vite-hub/agent'

try {
  await loadAgent('triage', {})
}
catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'AGENT_R0001') {
    // Use a discovered Agent name.
  }
  throw error
}
```

A wrapped lower-level failure stays in `cause` for protected in-process diagnostics. ViteHub does not wrap `DOMException`, `AggregateError`, cancellation errors, or app and third-party errors when the contract depends on their type.

`isRuntimeDiagnostic(error)` from `vite-hub/runtime` detects a live Nostics error, even across bundled copies. Then compare its `code` with the codes you handle. It rejects serialized records. It does not make diagnostic text safe for a public response.

Browser page evaluation, uploaded Sandbox scripts, standalone Deno deploy runners, and test helpers cannot load Nostics, so they throw native errors. The owning package translates or sanitizes them when they return to the ViteHub process.

## Operational errors

Packages that do not follow the error contract yet keep the `ViteHubError` contract from `vite-hub/runtime` for expected portable failures. HTTP boundaries, such as Agent public errors, also keep it. Examples include authentication requirements, provider operation failures, application failures in a Queue handler, and policy rejections. These semantic codes describe an application result instead of a developer defect.

`ViteHubError` copies and freezes its public `name`, `code`, `message`, `details`, and `requestId` when created. `toJSON()` omits its `cause`. Public details must be bounded JSON data.

Use an operational code to choose what your app does. Use a Nostics code to find and fix ViteHub config, build, or runtime code.

<a id="durability"></a>

## Durability diagnostics

A Node server throws `RUNTIME_R0017` at boot when `VITEHUB_INSTANCES` or `node.instances` is greater than 1 and a primitive keeps its state in one process or on one host. The message lists each primitive with its fix. Move each one to a shared store, or run one instance. `RUNTIME_R0018` means that the instance count is not a positive integer. See [Durability and instances](/docs/frameworks-hosts/node-self-hosted#durability-and-instances).

## Agent diagnostics

Agent config, build, and runtime defects use `AGENT_C####`, `AGENT_B####`, and `AGENT_R####`. Your own tools can use their own Nostics catalog:

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

Add `nostics` as a direct dependency to use it. Omit reporters for throw-only catalogs. ViteHub formats the error where it is reported.

AI SDK tool results, Codex and Claude Code MCP tool responses, tool-step reports, and CLI output keep the code and fix, without causes or stacks.

::warning
The model sees the diagnostic message, fix, sources, and docs. Put only text there that the model may read.
::

The AI SDK reads only `error.message`, so its adapter wraps a Nostics tool failure in an `Error` with the formatted message. The original diagnostic is its `cause`.

`normalizeRuntimeDiagnosticError(error)` keeps Nostics metadata, also from serialized errors, in bounded records. `formatRuntimeDiagnosticError(error)` from `vite-hub/runtime` formats them as text. Sources share the node limit, and all strings share the size limit, so large records can lose metadata.

Nostics does not change public HTTP error mapping, approval decisions, or cancellation. A diagnostic does not become a public `ViteHubError`. Unknown public failures map to `INTERNAL`. Public HTTP responses never include causes or stacks.

### Migrate existing error checks

For ViteHub defects, check the diagnostic code instead of native `TypeError` and `RangeError`. App and third-party errors do not change. Agent codes changed as follows:

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
| `AGENT_CAPABILITY_DUPLICATE` | `AGENT_C0009` |
| `AGENT_CAPABILITY_DYNAMIC_UNSUPPORTED` | `AGENT_C0010` |
| `AGENT_TOOL_POLICY_RETRYABLE` | `AGENT_R0003` |

Content uses `AGENT_C0012` for invalid `content()` options, `AGENT_R1011` when the `content` primitive is not a Content runtime with collections, and `AGENT_R1012` for an unknown collection. See [Content capability](/docs/content/agent-capability).

i18n uses `AGENT_C0014` for invalid `i18n()` options, and `AGENT_R0104` when the `i18n` primitive is missing or is not `agentI18n` from `vite-hub/i18n/server`. See [i18n capability](/docs/i18n/agent-capability).

Forge uses `AGENT_C0011` for invalid options. `AGENT_R0941` to `AGENT_R0945` cover credentials, repository access, context, requests, and tool input. See [Forge diagnostics](/docs/agents/capabilities/forge#diagnostics).

The `gitlab()` and `forgejo()` Channels use `AGENT_R0946` for a missing webhook secret, failed Forge requests, and activity errors. See [Forge Channels](/docs/agents/forge-channels#limits).

## Agent public errors

Agent routes and hooks give a sanitized `AgentPublicError` next to the original error. It is safe to send to a caller or use in your reply:

```ts
import type { AgentPublicErrorCode } from 'vite-hub/agent'

interface AgentPublicError {
  code: AgentPublicErrorCode
  error: string
  details?: {
    capability?: string
    category?: string
    resetAt?: string
    resetText?: string
    retryAfter?: number
  }
  requestId?: string
}
```

`agent:error` and Chat error hooks receive the raw failure as `error` and the sanitized value as `publicError`.

::warning
Keep the raw error in protected diagnostics. Provider payloads and causes can contain credentials or private response data.
::

| Public code | Meaning |
| --- | --- |
| `PROVIDER_AUTHENTICATION_FAILED` | The model provider rejected its credentials. |
| `PROVIDER_QUOTA_EXHAUSTED` | The account or project has no provider quota left. |
| `PROVIDER_RATE_LIMITED` | The provider returned a temporary rate limit. |
| `PROVIDER_UNAVAILABLE` | The provider returned a server or availability error. |
| `AGENT_BUDGET_EXCEEDED` | An Invocation went over its `budget` policy for tokens or estimated USD, in `enforce` mode. `details.limits` has the limits. `details.exceeded` lists each metric with its `actual` usage and `limit`. |
| `APPROVAL_REQUIRED` | A Capability needs approval to continue. `requestId` names the approval request, if there is one. |
| `HOST_RESTARTED` | The host restarted during an inline Chat invocation. `details.retry` is `pending` when ViteHub will retry the message, or `exhausted` after a second restart. |
| `TIMEOUT` | A Chat or queued webhook invocation hit its `timeout`. Chat replies say the Agent ran out of time, not the generic `INTERNAL` text. |
| `AUTHENTICATION_REQUIRED`, `RATE_LIMIT_*`, `CAPABILITY_*`, `TRANSCRIPTION_*` | A known public app or Capability failure. |
| `INTERNAL` | No approved public mapping. The message stays generic. |

`PROVIDER_QUOTA_EXHAUSTED` carries the reset time when the provider text says `try again at <time>.` with a timestamp ViteHub can parse.

- `resetText` keeps the provider's wording, for example `Sep 15th, 2026 1:23 AM`.
- `resetAt` is the same time as an ISO 8601 timestamp.
- Unknown, unparseable, or ambiguous text is omitted. Zone abbreviations with several meanings, such as `IST`, `BST`, and `CST`, are ambiguous.
- A time without a zone uses the server's local time zone.

`AGENT_BUDGET_EXCEEDED` comes after the Driver (the backend that runs the Agent) reports usage, so the provider request already ran. Treat it as the end of that Invocation. Record `details.exceeded`, change the policy or input, then start a new Invocation. Without a provider cost, ViteHub checks a USD limit only if the pricing resolver can estimate the cost. An unknown cost never exceeds the policy.

Public errors include only bounded ids, categories, retry delays, reset times, and request IDs. Unknown errors get a context-specific `INTERNAL` message, never a copy of `error.message`.

## Bundle checks

`vitehub bundle` checks the report of the last production build that had `bundle: true`. Each finding has a `code`, a `severity`, a `why`, a `fix`, a `docs` link, the bytes, and the import chain from the server entry, as `vitehub bundle why` gives it. `vitehub bundle --json` prints the findings in `findings`. An `error` makes the command exit with 1, so CI can run it after the build. A `warning` keeps exit code 0, like a Vite Doctor warning. [Bundle checks](/docs/bundle/checks) shows how to run them in CI.

### BUNDLE_STARTUP_UNUSED

Warning. A package loads at server startup, and a feature of this build knows that the server never runs it. The feature derives this from its resolved configuration, not from the package name. The Database declares the libSQL client on a Cloudflare build where every Database is D1 or Postgres and no Database can get a remote libSQL URL: a Worker has no files, so libSQL only serves the local SQLite that stands in for D1 in `vite dev`.

Read the chain from the end and update the ViteHub package that imports it. Imports from app code or other packages suppress the finding, because the feature cannot prove what those consumers need.

### BUNDLE_HOST_SIZE_LIMIT

Error. The server JavaScript is larger than the host accepts, so the deployment fails. Cloudflare rejects a Worker over 64 MiB before compression, on the Free and the Paid plan ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#worker-size)). The report counts only JavaScript, and Cloudflare also counts other files in the Worker, such as WebAssembly. Keep large data and binary files in KV, R2, D1, or static assets, and import large packages with `import()` in the routes that use them.

## Diagnostics sources

| Source | Use |
| --- | --- |
| CLI exit code and stderr | Command parsing, provisioning, and Agent Eval failures. |
| Env diagnostics | Whether each Env Declaration is missing, defaulted, valid, or masked. |
| Generated files | Discovery, Runtime Registry, and Provider Output inspection. |
| Agent Dev Loop responses | Local Agent inspection and invocation failures. |
| Trace Events | Runtime policy, approval, capability, lifecycle, and error records. |
| Package tests | Contract failures in the primitive package. |

## Local response

Start with the error's `code`.

- A numbered Nostics code names the owner package and failure site.
- Read an operational code with `getViteHubErrorShape(error)?.code`.
- If the package generates Provider Output, inspect it before you change runtime code.
- Authenticated Agent bridges tell `AUTHENTICATION_REQUIRED` apart from `AUTH_PROVIDER_OPERATION_FAILED`. Use `details.operation` for safe diagnostics, and `cause` only in protected server diagnostics.
- Email has no Provider Output. Read the `EMAIL_*` code. Its `why` names the driver.

For Env, read the `ENV_*` code first. Its codes and public messages are fixed:

- `ENV_DECLARATION_INVALID` can include `details.path`.
- `ENV_REQUIRED_MISSING` and `ENV_RUNTIME_VALUE_INVALID` can include a bounded source id and declaration path.
- `ENV_SOURCE_FAILED` can include a bounded source id such as `env`, `git:branch`, `package.json`, or `custom`.
- `ENV_RUNTIME_VALUE_INVALID` never includes the rejected value.

Raw labels and diagnostics stay in `cause`, which the serialized shape omits. Errors from custom source resolvers pass through unchanged.

```bash [Terminal]
pnpm vitehub provision run --provider cloudflare --dry-run
find .vitehub -maxdepth 4 -type f | sort
pnpm --filter @vite-hub/sandbox test
```

### Rate Limit diagnostics

| Symptom | Likely cause | Verify |
| --- | --- | --- |
| Conflicting Rate Limit policy | Two `requireRateLimit()` calls use the same stable ID with different static policies. | Open both reported source locations. Make the policies the same, or rename one ID. |
| Driver provides best-effort enforcement | A policy requires `strict`, but the provider cannot guarantee it. | Keep `strict` and pick another driver. Change the policy only if best-effort is acceptable. |
| Driver does not support the window | The provider supports fewer fixed-window periods than the policy type. | Use a supported period, or pick a driver that supports the window. |
| Production hosting requires an explicit provider | The build target is unknown or has no native Rate Limit provider. | On Cloudflare, set `provider: 'cloudflare'` with a project-unique `namespace`. Set `provider: 'memory'` only for a single-process deployment. Or build a custom Rate Limiter. |
| Cloudflare binding was not found | The running Worker or request context has no generated `ratelimits` output. | Inspect `wrangler.json`, then test the deployed Worker, not a separate Node process. |
| `reason: 'unavailable'` with `allowed: true` | A `failure: 'allow'` policy let work through after a driver error. | Record the decision and check provider health before you change the budget. |

## Verify a diagnostic

The `docs` link of a ViteHub diagnostic opens the page of its code, such as [`QUEUE_DISABLED`](/docs/queue/diagnostics/queue_disabled). Use these steps to repair the defect:

1. Read the full `code` and `fix` fields.
2. Inspect the Provider Output, source locations, or trace events that the diagnostic names.
3. After the fix, run the nearest package or consumer test again.

## Production response

Nitro answers an unhandled request error with a sanitized body. h3 logs only that sanitized error, and Cloudflare Workers drop its message and cause. So ViteHub adds a Nitro plugin that logs the real thrown error:

```txt
[vitehub] Unhandled error in POST /api/sync { message, stack, status, code, cause: { message, status, ... } }
```

The log follows the `cause` chain and keeps `status`, `code`, `fix`, and `requestId`. It skips errors that a route throws on purpose with a status below 500, such as a 401. With `vitehub({ observability })` on, evlog records request errors instead of this plugin.

Keep secrets out of production diagnostics. Put runtime secrets in Server Env and Secret Env. Package diagnostics hide known secret values where they support it.

## Related

- [Troubleshooting](/docs/development/troubleshooting)
- [Runtime events](/docs/reference/runtime-events)
- [Verification](/docs/development/verification)
