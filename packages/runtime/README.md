# @vite-hub/runtime

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Runtime" src="https://img.shields.io/badge/Runtime-context%20%7C%20policy%20%7C%20trace-18181b?style=flat-square">
</p>

`@vite-hub/runtime` owns Runtime Host Context, Runtime Capability handles, Policy Decisions, Approval Requests, Trace Events, and Leases. Other ViteHub packages use it to share runtime resources and operation policy without making every concept an Agent Capability.

## Install

```sh
pnpm add @vite-hub/runtime
```

## Minimal API

```ts
import {
  createExecutionContext,
  defineCapability,
  getCapability,
  resolveCapabilityPolicy,
} from "@vite-hub/runtime"

const kvRuntime = {
  get: async (_key: string) => null,
}

const context = createExecutionContext({
  runtime: "nitro",
  memo: (key, create) => create(),
  waitUntil: task => task.catch(() => {}),
  capabilities: {
    kv: defineCapability("kv", kvRuntime),
  },
})

const kv = getCapability(context, "kv")

const decision = await resolveCapabilityPolicy("require-approval", {
  capability: kv.name,
  operation: "write",
})
```

## Entry points

- `@vite-hub/runtime`: runtime context helpers, capability helpers, policy resolution, approval errors, trace types, and lease types.

Learn more at [vitehub.dev](https://vitehub.dev).
