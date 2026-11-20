# @vite-hub/mcp decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## MCP auth metadata and discovery

`listedTool`, `securitySchemes`, `visible`, `Nitro middleware registration`, `generated file writers` in `packages/mcp/src/runtime.ts`, `packages/mcp/src/vite.ts`, `packages/webhooks/src/vite.ts`.

**Context:** ChatGPT reads auth hints in non-standard places; OAuth well-known paths are at the origin root; Nitro and Queue read files early.

**Decision:** Duplicate securitySchemes in _meta; refuse via tool result on optional routes; list all tools anonymously; register discovery as route-less middleware; write generated files early.

**Consequences:** Data duplication; tool schemas are public; depends on hook order.
