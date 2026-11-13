import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const mcpErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/mcp/diagnostics",
  codes: {
    // `mcp.route` or `mcp.publicRoute` is not a path, or both are the same path.
    MCP_B0001: dynamicError,
    // A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name.
    MCP_B0002: dynamicError,
    // `mcp.publicRoute` is set with `auth: false`, where every tool on `mcp.route` is already public.
    MCP_B0003: {
      ...dynamicError,
      fix: "Remove `publicRoute`, or remove `auth: false` and add `mcpOAuth()` from `vite-hub/auth/mcp` to `server/auth.ts`.",
    },
    // A tool sets `public`, but the server has no `mcp.publicRoute` that could serve it.
    MCP_R0001: {
      ...dynamicError,
      fix: "Set `mcp: { route: \"/mcp/account\", publicRoute: \"/mcp\" }` in `vitehub()` to serve the tool without sign-in, or remove `public` from the tool.",
    },
  },
})
