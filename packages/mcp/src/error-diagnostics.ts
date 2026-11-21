import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const mcpErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/mcp/diagnostics",
  codes: {
    // `mcp.route` or `mcp.publicRoute` is not a path, or both are the same path.
    MCP_B0001: { ...dynamicError, fix: "Set `mcp.route` and `mcp.publicRoute` in `vitehub()` to two different paths without a query or `//`, such as `mcp: { route: \"/mcp/account\", publicRoute: \"/mcp\" }`." },
    // A file in `server/mcp/tools/` has a name that MCP does not allow as a tool name.
    MCP_B0002: { ...dynamicError, fix: "Rename the file of `server/mcp/tools/` that the message names, or move it out of its subfolder, so that the tool name has 1 to 128 letters, digits, `_`, `-`, or `.`." },
    // `mcp.publicRoute` is set with `auth: false` or `auth: "optional"`, where `mcp.route` already serves the public tools.
    MCP_B0003: {
      ...dynamicError,
      fix: "Remove `publicRoute`, or set `auth: true` and add `mcpOAuth()` from `vite-hub/auth/mcp` to `server/auth.ts`.",
    },
    // A tool sets `access`, but the server has neither `mcp.publicRoute` nor `auth: "optional"` that could serve it.
    MCP_R0001: {
      ...dynamicError,
      fix: "Set `mcp: { auth: \"optional\" }` in `vitehub()` to serve the tool without sign-in on the same route, set `mcp: { route: \"/mcp/account\", publicRoute: \"/mcp\" }` to serve it on a second route, or remove `access` from the tool.",
    },
    // More than one server directory has an `mcp.ts` hooks module.
    MCP_B0004: { ...dynamicError, fix: "Keep one `mcp.ts` with the `defineMcpHooks()` default export, in one server directory." },
  },
})
