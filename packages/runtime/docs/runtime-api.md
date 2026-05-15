---
title: Runtime API
description: Public exports for ViteHub runtime context, capabilities, policy, approvals, tracing, and leases.
navigation.title: Runtime API
navigation.order: 1
---

```ts
import {
  createExecutionContext,
  defineCapability,
  getCapability,
  hasCapability,
  resolveRuntimeValue,
} from '@vitehub/runtime'
```

## Context

`createExecutionContext(context)` normalizes host context and ensures `runtimeConfig` and `capabilities` are present.

```ts
const context = createExecutionContext({
  memo,
  runtime: 'vercel',
  runtimeConfig: { region: 'iad1' },
  waitUntil,
})
```

## Capabilities

`defineCapability(kind, value, options?)` creates a typed handle. `getCapability(context, name)` returns a handle or throws when the capability is missing.

```ts
const sandbox = defineCapability('sandbox', sandboxClient)
const handle = getCapability(context, 'sandbox')
```

## Policy and Approvals

Policies return `allow`, `deny`, `require-approval`, or `retryable-failure`. Approval requests are stateful records that can be persisted or surfaced by an interface package.

```ts
const request = {
  capability: 'refund',
  id: 'approval_1',
  input: { amount: 100 },
  state: 'awaiting-approval',
}
```

## Tracing and Lifecycle

`TraceContext`, `TraceEvent`, and `RunLifecycleHooks` provide correlation and instrumentation contracts. Packages can emit trace events without depending on a specific observability provider.

## Leases

`Lease` and `LeaseStore` model ownership for threads, runs, resumable streams, or provider resources. The runtime package defines the contract; storage-specific packages implement it.
