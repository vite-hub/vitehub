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

`ViteHubError` clones and freezes its JSON-safe public details at construction, and `toJSON()` always returns that immutable snapshot. Put raw provider failures in `cause`; changing the original details or the error's public fields later cannot change serialized output. Accessors, cycles, `bigint`, non-finite numbers, and oversized detail trees are rejected with a fixed `TypeError`, so callers that previously passed mutable or non-JSON detail objects must normalize them first.

## Used by

Feature packages use Runtime Capability handles instead of passing every provider client through every API. Agent Capabilities consume these handles when they expose KV, Blob, DB, sandbox, shell, or workspace behavior.

Learn more at [vitehub.dev](https://vitehub.dev).
