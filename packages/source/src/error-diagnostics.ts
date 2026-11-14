import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: SOURCE_R0010.
export const sourceErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/source/diagnostics",
  codes: {
    SOURCE_R0023: dynamicError,
    SOURCE_R0001: dynamicError,
    SOURCE_R0002: dynamicError,
    SOURCE_R0003: dynamicError,
    SOURCE_R0004: dynamicError,
    SOURCE_R0005: dynamicError,
    SOURCE_R0006: dynamicError,
    SOURCE_R0007: dynamicError,
    SOURCE_R0008: dynamicError,
    SOURCE_R0009: dynamicError,
    SOURCE_R0011: dynamicError,
    SOURCE_R0012: dynamicError,
    SOURCE_R0013: dynamicError,
    SOURCE_R0014: dynamicError,
    SOURCE_R0015: dynamicError,
    SOURCE_R0016: dynamicError,
    SOURCE_R0017: dynamicError,
    SOURCE_R0018: dynamicError,
    SOURCE_R0019: dynamicError,
    SOURCE_R0020: dynamicError,
    SOURCE_R0021: dynamicError,
    SOURCE_R0022: dynamicError,
    SOURCE_R0024: dynamicError,
    SOURCE_R0025: dynamicError,
    SOURCE_R0026: dynamicError,
    SOURCE_R0027: dynamicError,
    SOURCE_R0028: dynamicError,
    SOURCE_R0029: dynamicError,
    SOURCE_R0030: dynamicError,
    SOURCE_R0031: dynamicError,
    SOURCE_R0032: dynamicError,
    SOURCE_R0033: dynamicError,
    SOURCE_R0034: {
      why: ({ endpoint, status }: { endpoint: string; status: number }) => `[vitehub] Collection request to ${endpoint} failed with status ${status}.`,
      fix: "Check the Collection route and server logs for this HTTP status, correct the request or server error, then refresh the Collection.",
    },
    SOURCE_R0035: {
      why: "[vitehub] A routed Collection must set authorize or access. Without one, the generated /api route would serve every item to anyone.",
      fix: "Set `authorize: true` to require a signed-in session, a callback to decide each request, or `access: \"public\"` for a public route. Set `route: false` to keep the Collection server-only.",
    },
    SOURCE_R0036: {
      why: "[vitehub] A Collection over table() with `access: \"public\"` would serve every column of each row, such as password hashes or emails.",
      fix: "Add `transform` that returns only the public fields, or replace `access: \"public\"` with `authorize: true` or a callback.",
    },
    SOURCE_R0037: {
      why: "[vitehub] Collection `authorize: false` does not make a route public.",
      fix: "Replace `authorize: false` with `access: \"public\"` to let anyone read the route. Use `authorize: true` or a callback to require sign-in.",
    },
    SOURCE_R0038: {
      why: "[vitehub] A Collection cannot set both `access: \"public\"` and `authorize`.",
      fix: "Keep `access: \"public\"` to let anyone read the route, or keep `authorize` to check each request. Remove the other.",
    },
    SOURCE_B0001: dynamicError,
    SOURCE_B0002: dynamicError,
    SOURCE_B0003: dynamicError,
    SOURCE_B0004: dynamicError,
    SOURCE_B0005: dynamicError,
    SOURCE_B0006: dynamicError,
    SOURCE_B0007: dynamicError,
    SOURCE_B0008: dynamicError,
    SOURCE_B0009: {
      ...dynamicError,
      fix: "Write `export default defineContent({ ... })` in server/content.ts. Run `npx @vite-hub/codemods define-forms` to move the export and the imports of it.",
    },
    SOURCE_B0010: {
      why: ({ route, other }: { route: string, other: string }) => `[vitehub] defineContent({ seo: { mcp } }) serves its MCP server at ${JSON.stringify(route)}, and ${other} answers there too.`,
      fix: "One route serves one MCP server. Give the app MCP server another route, such as `vitehub({ mcp: { route: '/mcp/app' } })`, or another `publicRoute`. Or set `seo: { mcp: false }` in server/content.ts.",
    },
  },
})
