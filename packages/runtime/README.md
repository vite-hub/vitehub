# @vite-hub/runtime

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Runtime" src="https://img.shields.io/badge/Runtime-context%20%7C%20policy%20%7C%20trace-18181b?style=flat-square">
</p>

`@vite-hub/runtime` shares host context, capability handles, policy decisions, approvals, traces, and leases across packages.

## Install

```sh
pnpm add @vite-hub/runtime
```

## Minimal API

```ts
// server/utils/runtime-context.ts
import {
  createExecutionContext,
  defineCapability,
  getCapability,
  resolveCapabilityPolicy,
} from "@vite-hub/runtime"

const context = createExecutionContext({
  runtime: "vite",
  memo: (key, create) => create(),
  waitUntil: task => task.catch(() => {}),
  capabilities: {
    kv: defineCapability("kv", {
      get: async (_key: string) => null,
    }),
  },
})

const kv = getCapability(context, "kv")

const decision = await resolveCapabilityPolicy("require-approval", {
  capability: kv.name,
  operation: "write",
})
```

An omitted policy resolves to `allow`. Pass `require-approval` or `deny` when an operation needs an explicit gate.

## Execution authority

`ExecutionAuthority` is the normalized, provider-independent description of what one resolved execution surface grants. It records filesystem access and scope, network egress, environment inheritance, credential access, process execution, and the isolation mechanism. Read it from the resolved owner, such as `box.plan.executionAuthority`, `WorkspaceSession.executionAuthority`, `SandboxRunner.executionAuthority`, or `AgentInspectionMetadata.config.driver.executionAuthority`.

Each resolved descriptor is an immutable snapshot of the authority known at resolution time. `unknown` means the provider cannot prove or did not report that dimension; it never means `none`. `isolation` identifies a mechanism such as a container or microVM, but it is not a security rank and does not imply anything about filesystem, network, credentials, or processes. Providers must report every dimension explicitly instead of inheriting a permissive default.

Executable selection, fixed argument arrays, and executable allowlists are dispatch controls. They do not constrain what a selected process can read, reach, inherit, or spawn, so they are not represented as isolation.

`ViteHubError` clones and freezes its JSON-safe public details at construction, and `toJSON()` always returns that immutable snapshot. Put raw provider failures in `cause`; changing the original details or the error's public fields later cannot change serialized output. Accessors, cycles, `bigint`, non-finite numbers, and oversized detail trees are rejected with a fixed `TypeError`, so callers that previously passed mutable or non-JSON detail objects must normalize them first.

## Used by

Feature packages use Runtime Capability handles instead of passing every provider client through every API. Agent Capabilities consume these handles when they expose KV, Blob, DB, sandbox, shell, or workspace behavior.

Learn more at [vitehub.dev](https://vitehub.dev).
