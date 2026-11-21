---
title: Runtime error contract
navigation.title: Errors
description: "Return [error, data] results, define a catalog of error codes with defineErrors(), and format diagnostics with vite-hub/runtime."
navigation.order: 5
navigation.group: Reference
icon: i-lucide-circle-alert
---

Every ViteHub primitive follows one error contract, and `vite-hub/runtime` owns it. You can use the same contract in your own server code. [Errors and diagnostics](/docs/reference/errors-diagnostics) explains how to read the errors that ViteHub packages return.

## Follow the contract

1. A runtime operation returns `[error, data]`. An error before a stream starts is in the tuple. An error after the stream starts goes into the stream.
2. A Definition or config error throws: at build time, at define time, or when an operation starts.
3. A package defines a small catalog with `defineErrors()`. Each code has a guessable name, a `why`, and a `fix`.
4. Each method type lists the union of the codes that it can return.
5. Each code has its own docs page, so `error.docs` opens it.

## Define a catalog

`defineErrors()` takes the codes and the base URL of their docs pages. It returns one function for each code. Each function creates a `ResultError` with that code.

```ts [server/utils/list-orders.ts]
import { defineErrors, type Result } from 'vite-hub/runtime'

const errors = defineErrors({
  docs: 'https://example.com/docs/errors',
  codes: {
    ORDERS_INVALID_LIMIT: { why: '`limit` must be a positive integer.', fix: 'Pass a positive integer.' },
  },
})

export async function listOrders(limit: number): Promise<Result<string[], 'ORDERS_INVALID_LIMIT'>> {
  if (!Number.isInteger(limit) || limit <= 0) return [errors.ORDERS_INVALID_LIMIT(), undefined]
  return [undefined, []]
}
```

- `docs` is the base URL. The `docs` link of an error is `<docs>/<code in lowercase>`, such as `https://example.com/docs/errors/orders_invalid_limit`.
- `Result<Data, Code>` is the tuple type. When `error` is `undefined`, `data` has the value.
- Give each code a real `why` and `fix`. Do not pass a free message as the `why`.

Check `error` first, then use `data`:

```ts [server/api/orders.get.ts]
import { listOrders } from '../utils/list-orders'

export default {
  async fetch(request: Request) {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 20)
    const [error, orders] = await listOrders(limit)
    if (error) return Response.json(error, { status: 400 })
    return Response.json(orders)
  },
}
```

`Response.json(error)` calls `error.toJSON()`, so the body has only the public fields.

## `ResultError`

A `ResultError` is a [Nostics](https://github.com/vercel-labs/nostics) diagnostic with a typed `code`.

| Property | Value |
| --- | --- |
| `code` and `name` | The code, such as `ORDERS_INVALID_LIMIT`, with its literal type. |
| `why` | What went wrong. `message` has the same text. |
| `fix` | What to do next. |
| `docs` | The link to the page of the code. |
| `cause` | The lower-level error, such as the provider error. |
| `data` | Catalog metadata, in memory only. |

A catalog code can give static or computed `data`. `defineErrors()` infers its type for each code. `ResultError<Code, Data>` names the type explicitly. A bare `ResultError` or `ResultError<Code>` keeps `data` as `unknown`, so it accepts any catalog error.

`toJSON()` returns only `name`, `code`, `why`, `fix`, and `docs`. Cause, stack, sources, and `data` stay in memory and are never in the JSON. The `toJSON()` return type keeps the Nostics serializer fields, so `formatDiagnostic()` from Nostics accepts the error. Read `data` from the error itself.

`toResultError(diagnostic)` gives a Nostics diagnostic of another catalog the same public serializer. It keeps the same object when it can replace `name` and `toJSON`. Otherwise it makes a copy with the same code, text, cause, data, sources, and stack. You choose which codes you allow and which text is public.

## `ViteHubError`

Packages that do not follow the error contract yet throw `ViteHubError` for expected failures. HTTP boundaries, such as Agent public errors, also use it.

- `new ViteHubError(code, message, { details, requestId, cause })` keeps a JSON-safe snapshot of `name`, `code`, `message`, `details`, and `requestId`, and freezes it.
- `toJSON()` never includes `cause`. Code and loggers that read the `Error` object can still read it.
- `isViteHubError(value)` recognizes an instance or its JSON shape by its `ViteHubError` name, also from another bundled copy.

Never put secrets in `message` or `details`. Keep raw provider failures in `cause`.

## Developer diagnostics

Runtime defects of the API itself use Nostics codes `RUNTIME_R####`. These helpers read any thrown value:

| Function | Use |
| --- | --- |
| `normalizeRuntimeDiagnosticError(error)` | Make a bounded record of an error. It keeps Nostics codes, fixes, docs links, and source locations, also from JSON records. Causes, details, and sources share a node budget, and all strings share a size budget. Add `{ includeStack: true }` for stacks. |
| `formatRuntimeDiagnosticError(error)` | Format an error for a terminal or an Agent tool result: code, message, fix, sources, and docs link. It omits causes and stacks. A plain error gives its message. |
| `isRuntimeDiagnostic(error)` | Recognize a live Nostics error, also from another bundled copy. It rejects serialized records. |

These helpers are for developers. They do not make an error safe for a public response. At that boundary, allow only the codes that you handle, and use `toResultError()` or `ViteHubError`.

## Related

- [Errors and diagnostics](/docs/reference/errors-diagnostics)
- [All diagnostics](/docs/reference/diagnostics)
- [Runtime Server API](/docs/runtime/server-api)
