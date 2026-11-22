# @vite-hub/mcp decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Keep elicitation answers bound to the waiting tool call

`callTool` and `answerElicitation` in `packages/internal/src/runtime/mcp-server.ts` and `elicitationUnsupportedHost` in `packages/mcp/src/vite.ts`.

**Context:** The client sends its answer in a separate POST while the original tool call waits on an SSE stream.

**Decision:** Keep the waiting call in memory and accept its answer only from the same endpoint, session, and caller. Reject elicitation on hosts that can route the POST to a different instance.

**Consequences:** The host must route both requests to the same process; a response ID alone does not authorize an answer.

## MCP auth metadata and discovery

`listedTool`, `securitySchemes`, `visible`, `Nitro middleware registration`, `generated file writers` in `packages/mcp/src/runtime.ts`, `packages/mcp/src/vite.ts`, `packages/webhooks/src/vite.ts`.

**Context:** ChatGPT reads auth hints in non-standard places; OAuth well-known paths are at the origin root; Nitro and Queue read files early.

**Decision:** Duplicate securitySchemes in _meta; refuse via tool result on optional routes; list all tools anonymously; register discovery as route-less middleware; write generated files early.

**Consequences:** Data duplication; tool schemas are public; depends on hook order.

## Cancel the body of a request that fails authentication, and ignore a failed cancel

`cancelRequestBodyQuietly` in `packages/mcp/src/runtime.ts`.

**Context:** A request without a valid token gets a 401 before the handler reads its body. Some dev proxies drop the connection when the server answers and leaves the request body unread. The proxy was not identified, and the failure was not reproduced again after the change that added this (vite-hub/vitehub#4410).

**Decision:** Cancel the body before the 401, so the server reads no bytes from an unauthenticated caller. A rejected `cancel()`, for example on a locked or errored stream, does not change the 401.

**Consequences:** Without the cancel, the dev proxy can drop the connection, and the client sees a network error instead of the OAuth challenge. Remove it when a dev run through the Nitro dev server shows the 401 without it.
