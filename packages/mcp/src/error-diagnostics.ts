import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const mcpErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/mcp/diagnostics",
  codes: {
    MCP_B0001: { ...dynamicError, fix: "Set `mcp.route` and `mcp.publicRoute` in `vitehub()` to two different paths without a query or `//`, such as `mcp: { route: \"/mcp/account\", publicRoute: \"/mcp\" }`." },
    MCP_B0002: { ...dynamicError, fix: "Rename the file of `server/mcp/tools/` that the message names, or move it out of its subfolder, so that the tool name has 1 to 128 letters, digits, `_`, `-`, or `.`." },
    MCP_B0003: {
      ...dynamicError,
      fix: "Remove `publicRoute`, or set `auth: true` and add `mcpOAuth()` from `vite-hub/auth/mcp` to `server/auth.ts`.",
    },
    MCP_R0001: {
      ...dynamicError,
      fix: "Set `mcp: { auth: \"optional\" }` in `vitehub()` to serve the tool without sign-in on the same route, set `mcp: { route: \"/mcp/account\", publicRoute: \"/mcp\" }` to serve it on a second route, or remove `access` from the tool.",
    },
    MCP_B0004: { ...dynamicError, fix: "Keep one `mcp.ts` with the `defineMcpHooks()` default export, in one server directory." },
  },
})
