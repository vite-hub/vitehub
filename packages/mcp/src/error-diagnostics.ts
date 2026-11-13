import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const mcpErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/mcp/diagnostics",
  codes: {
    // `mcp.route` is not a path.
    MCP_B0001: dynamicError,
    // A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name.
    MCP_B0002: dynamicError,
  },
})
