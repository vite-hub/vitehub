---
title: Messages troubleshooting
description: Fix invalid roles, non-serializable values, and tool event ordering.
navigation.title: Troubleshooting
navigation.order: 4
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when message validation throws.

## Unsupported role

Error:

```txt
[vitehub:messages] Unsupported message role
```

Fix: use one of the supported roles.

```ts
createMessage({
  role: 'user',
  text: 'Hello',
})
```

## Non-serializable state

Error:

```txt
[vitehub:messages] message.metadata.startedAt must be serialized before storing.
```

Cause: message state contains a runtime-only value such as a `Date`, function, symbol, `bigint`, `undefined`, or non-finite number.

Fix: store plain structured data.

```ts
createMessage({
  role: 'assistant',
  metadata: {
    startedAt: new Date().toISOString(),
  },
})
```

## Tool result has no matching call

Error:

```txt
[vitehub:messages] tool-result "tool_1" must follow a matching tool-call or approval-request.
```

Fix: apply the tool call first.

```ts
messages = applyStreamEvent(messages, {
  type: 'tool-call',
  id: 'tool_1',
  name: 'lookupOrder',
})

messages = applyStreamEvent(messages, {
  type: 'tool-result',
  id: 'tool_1',
  name: 'lookupOrder',
  output: { ok: true },
})
```

## Data part is missing data

Error:

```txt
[vitehub:messages] data part requires data.
```

Fix: include the `data` key and keep the value JSON-safe.
