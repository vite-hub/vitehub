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
    // More than one server directory has an `mcp.ts` hooks module.
    MCP_B0003: dynamicError,
  },
})
