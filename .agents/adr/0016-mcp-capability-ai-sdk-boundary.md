# MCP Capability AI SDK Boundary

The `mcp()` helper remains an Agent Capability that consumes external MCP Servers and exposes their model-facing tools through the Capability Lifecycle. ViteHub will build this as a thin layer over AI SDK MCP instead of reimplementing MCP client or protocol behavior: ViteHub owns capability composition, tool namespacing, metadata redaction, default instructions, and lifecycle cleanup, while AI SDK owns MCP client behavior.

`@ai-sdk/mcp` stays optional and lazily loaded. The root and `@vite-hub/agent/capabilities` surfaces may expose `mcp()` but must not eagerly import MCP client helper code; explicit MCP client/server helper construction belongs behind a dedicated `@vite-hub/agent/mcp` export path. MCP resources and prompts are intentionally deferred to the Dynamic Source design rather than being hidden behind the MCP Capability.
