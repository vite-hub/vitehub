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
    // More than one server directory has an `mcp.ts` hooks module.
    MCP_B0004: { ...dynamicError, fix: "Keep one `mcp.ts` with the `defineMcpHooks()` default export, in one server directory." },
    // A tool calls `elicit()`, but the MCP client did not declare the `elicitation` capability in `initialize`.
    MCP_ELICITATION_CLIENT_UNSUPPORTED: {
      why: ({ tool }: { tool: string }) => `The MCP tool ${tool} asks the person for input, but this MCP client cannot ask the person: it did not declare the elicitation capability.`,
      fix: "Use an MCP client that supports elicitation in form mode. Or catch the error in the tool and take the values as tool arguments.",
    },
    // A tool calls `elicit()` in a build for a host where the answer of the client can reach another server instance.
    MCP_ELICITATION_HOST_UNSUPPORTED: {
      why: ({ host, tool }: { host: string, tool: string }) => `The MCP tool ${tool} asks the person for input, but the app runs on ${host}. There, the answer of the client can reach another server instance than the waiting tool call.`,
      fix: "Deploy the MCP server as one Node, Bun, or Deno server process. Or take the values as tool arguments.",
    },
  },
})
