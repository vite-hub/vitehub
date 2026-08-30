# @vite-hub/runtime

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Runtime" src="https://img.shields.io/badge/Runtime-context%20%7C%20policy%20%7C%20trace-18181b?style=flat-square">
</p>

`@vite-hub/runtime` provides the shared Runtime Host Context, Runtime Capability,
policy, approval, trace, error, lease, and execution-authority contracts used by
ViteHub packages and custom host integrations.

## Choose an import

| You are building                              | Install                   | Import                                              |
| --------------------------------------------- | ------------------------- | --------------------------------------------------- |
| A ViteHub application                         | `vite-hub`                | `vite-hub/runtime`                                  |
| A reusable package or custom host integration | `@vite-hub/runtime`       | `@vite-hub/runtime`                                 |
| Node resource diagnostics in either case      | The same selected package | `vite-hub/runtime/node` or `@vite-hub/runtime/node` |

Use the `vite-hub` facade when it is already your application dependency. Install
this owner package directly when the integration should depend only on Runtime's
portable contracts. This package does not register Vite, Nuxt, routes, providers,
or Agent Definitions.

## Install the owner package

```sh
pnpm add @vite-hub/runtime
```

The package declares Node.js 24 or newer. Import the root entry for portable
Runtime contracts. When inspected, the `/node` entry reads Node process
information and, on Linux, `/proc` and cgroup v2 files.

## Get a first result

Create the host context explicitly, register one Runtime Capability, and look it
up through the public package entry:

```ts
import { createExecutionContext, defineCapability, getCapability } from "@vite-hub/runtime";

const values = new Map<string, unknown>();
const context = createExecutionContext({
  capabilities: {
    health: defineCapability("health", { status: "ready" }),
  },
  memo<T>(key: string, create: () => T): T {
    if (!values.has(key)) values.set(key, create());
    return values.get(key) as T;
  },
  runtime: "node",
  waitUntil(task) {
    void task.catch(console.error);
  },
});

const health = getCapability(context, "health");
console.log(`${context.runtime}:${health.kind}`);
```

Running the file prints:

```text
node:health
```

This proves context construction and capability lookup. The `waitUntil` fallback
only observes rejected promises in a long-lived process. It does not keep a
serverless request alive. A production host must delegate background work to its
provider lifetime API.

`createExecutionContext()` always returns a complete Execution Context. It creates
fresh empty `capabilities` and `runtimeConfig` objects when the host omits them,
and preserves the supplied objects when the host provides them.

## Understand the boundaries

### Runtime Host Context

`createExecutionContext()` normalizes an object supplied by the host. The host
still owns `runtime`, `memo`, `waitUntil`, request or event data, provider
bindings, and cleanup. Runtime does not discover framework globals, propagate an
ambient context, or isolate concurrent requests.

Treat every value on the context as available to code that receives it. Runtime
does not clone, redact, encrypt, or restrict `request`, `event`, `cloudflare.env`,
`runtimeConfig`, or Runtime Capability values. Pass only the bindings and secrets
needed by that operation, and do not copy secrets into traces or approval input.

### Runtime Capabilities

`defineCapability()` and `getCapability()` pass a named implementation between
packages. A handle is not a permission boundary: code that receives its `value`
can call that implementation. Keep authentication, tenant checks, input
validation, rate limits, and provider credentials at the application or provider
boundary that owns the operation.

### Policy and approvals

`resolveCapabilityPolicy()` evaluates a decision. An omitted policy resolves to
`allow`; `deny` and `require-approval` have an effect only when the calling
feature checks the decision before performing work. The approval interfaces are
records, not a durable approval queue or trusted approver service. The host must
authenticate the actor, persist and correlate decisions when required, prevent
replay, and resume or reject the operation.

### Traces

`createTraceEventLog()` is an in-memory log. Its default `metadata` policy omits
known content-bearing attribute keys such as `input`, `prompt`, `body`, and
`output`, including nested keys. This is bounded omission by key, not general
secret detection. Arbitrary names such as `token` or `authorization` are not
automatically redacted, and `error.message` is retained. `{ content: "content" }`
retains all supplied attributes.

Own trace access, retention, size limits, redaction, and durable export in the
host. `entries()` returns the current in-memory entries; it does not persist or
stream them by itself.

### Execution authority and public errors

`ExecutionAuthority` is an immutable snapshot of the filesystem, network,
environment, credentials, process, and isolation properties reported when an
execution surface is resolved. It describes those properties; it does not enforce
them. `unknown` means the provider did not prove a dimension; it never means
`none`. An isolation label such as `container` or `microvm` is not a security rank.

`ViteHubError` snapshots its JSON-safe public `name`, `code`, `message`, `details`,
and `requestId` at construction, and freezes the serialized snapshot and its
details. Never put secrets in those fields; keep raw provider failures in `cause`.
A `cause` is excluded from `toJSON()`, but remains available to code and loggers
that inspect the Error instance.

## Public entry points

| Import                   | Provides                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `@vite-hub/runtime`      | Context, capability, policy, approval, trace, lease, diagnostic, error, and execution-authority APIs |
| `@vite-hub/runtime/node` | Node process observations plus Linux host and cgroup v2 observations when supported                  |

Do not import from `src`, `dist`, or ViteHub's `_internal` paths.

## Go deeper

- [Runtime Context](https://vitehub.dev/docs/concepts/runtime-context)
- [Runtime policy, approvals, and traces](https://vitehub.dev/docs/concepts/runtime-policy-approvals-and-traces)
- [Runtime events](https://vitehub.dev/docs/reference/runtime-events)
- [Stable import paths](https://vitehub.dev/docs/reference/import-paths)
- [Node Runtime diagnostics](https://vitehub.dev/docs/capabilities/diagnostics)
- [Report a Runtime issue](https://github.com/vite-hub/vitehub/issues/new)
