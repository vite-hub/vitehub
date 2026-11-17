import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: SOURCE_R0007, SOURCE_R0010, SOURCE_R0019, and SOURCE_R0020.
export const sourceErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/source/diagnostics",
  codes: {
    SOURCE_COLLECTION_ACCESS_CONFLICT: {
      why: "[vitehub] A Collection cannot set both `access: \"public\"` and `authorize`.",
      fix: "Keep `access: \"public\"` to let anyone read the route, or keep `authorize` to check each request. Remove the other.",
    },
    SOURCE_COLLECTION_ACCESS_REQUIRED: {
      why: "[vitehub] A routed Collection must set authorize or access. Without one, the generated /api route would serve every item to anyone.",
      fix: "Set `authorize: true` to require a signed-in session, a callback to decide each request, or `access: \"public\"` for a public route. Set `route: false` to keep the Collection server-only.",
    },
    SOURCE_COLLECTION_AUTHORIZE_FALSE: {
      why: "[vitehub] Collection `authorize: false` does not make a route public.",
      fix: "Replace `authorize: false` with `access: \"public\"` to let anyone read the route. Use `authorize: true` or a callback to require sign-in.",
    },
    SOURCE_COLLECTION_PUBLIC_TRANSFORM_REQUIRED: {
      why: "[vitehub] A Collection over table() with `access: \"public\"` would serve every column of each row, such as password hashes or emails.",
      fix: "Add `transform` that returns only the public fields, or replace `access: \"public\"` with `authorize: true` or a callback.",
    },
    SOURCE_R0023: {
      ...dynamicError,
      fix: "Pass the `cursor` of the last page of this Collection without changes, or omit `cursor` to read the first page.",
    },
    SOURCE_R0001: {
      ...dynamicError,
      fix: "Check that only the Collection route of `defineCollectionHandler()` answers at `/api/<name>`, with no other route or proxy there, and that the client and the server use the same `@vite-hub/source` version.",
    },
    SOURCE_R0002: {
      ...dynamicError,
      fix: "Check that only the Collection route of `defineCollectionHandler()` answers at `/api/<name>`, with no other route or proxy there, and that the client and the server use the same `@vite-hub/source` version.",
    },
    SOURCE_R0003: {
      ...dynamicError,
      fix: "Make the Collection return a different `nextCursor` on each page, such as a `cursor()` that returns the id of the last item.",
    },
    SOURCE_R0004: {
      ...dynamicError,
      fix: "Pass `limit`, and `defaultLimit` and `maxLimit` of `defineCollection()`, as whole numbers of 1 or more.",
    },
    SOURCE_R0005: {
      ...dynamicError,
      fix: "Return only JSON values from `cursor()` of the Collection: strings, numbers, booleans, null, arrays, and plain objects.",
    },
    SOURCE_R0006: {
      ...dynamicError,
      fix: "Change the value that the message names so that the Collection schema accepts it: the item for `array({ schema })`, or the `filter` query for `querySchema`.",
    },
    SOURCE_R0008: {
      ...dynamicError,
      fix: "Set `defaultLimit` of `defineCollection()` to a value that is not larger than `maxLimit`.",
    },
    SOURCE_R0009: {
      ...dynamicError,
      fix: "Pass `defineCollection()` a loader with options, or `{ source }` with a `load()` method. Return what the message names: an array, `{ items, nextCursor }` from a provider loader, or `{ items, digest }` from the `array()` load.",
    },
    SOURCE_R0011: {
      ...dynamicError,
      fix: "Send each Collection query parameter, such as `limit` or `cursor`, at most one time in the URL.",
    },
    SOURCE_R0012: {
      ...dynamicError,
      fix: "Send `limit` as a whole number of 1 or more in the Collection URL, such as `?limit=20`.",
    },
    SOURCE_R0013: {
      ...dynamicError,
      fix: "Send `limit` as a whole number of 1 or more in the Collection URL, such as `?limit=20`.",
    },
    SOURCE_R0014: {
      ...dynamicError,
      fix: "Use `transform` of `defineCollection()` to return plain objects, arrays, and values with `toJSON()`, such as a Date, in place of class instances.",
    },
    SOURCE_R0015: {
      ...dynamicError,
      fix: "Use `transform` of `defineCollection()` to return JSON values only. Remove functions, symbols, and `undefined` items from the page.",
    },
    SOURCE_R0016: {
      ...dynamicError,
      fix: "Pass `defineCollectionHandler()` a Collection that `defineCollection()` returns.",
    },
    SOURCE_R0017: {
      ...dynamicError,
      fix: "Pass `file()` a `path` or a `workspacePath`.",
    },
    SOURCE_R0018: {
      ...dynamicError,
      fix: "Pass `file()` a `path` to read, or the `content` of the file.",
    },
    SOURCE_R0021: {
      ...dynamicError,
      fix: "Make `mcpResources({ server })` resolve to an MCP client or an MCP client config, such as `{ url }`.",
    },
    SOURCE_R0022: {
      ...dynamicError,
      fix: "Pass `mcpResources()` a `server` option with an MCP client, an MCP client config, or a function that returns one.",
    },
    SOURCE_R0024: {
      ...dynamicError,
      fix: "Set `authorize` of `defineCollection()` to `true`, or to a function that returns `true`, `false`, or a `Response`.",
    },
    SOURCE_R0025: {
      ...dynamicError,
      fix: "Enable Auth with a `server/auth.ts` Auth Definition, or remove `authorize` from the Collection to make it public.",
    },
    SOURCE_R0026: {
      ...dynamicError,
      fix: "Sign in before you read this Collection, or change its `authorize` callback so that it allows this user.",
    },
    SOURCE_R0027: {
      ...dynamicError,
      fix: "Read the Collection again from the first page without `cursor`, because its data or query changed after that cursor.",
    },
    SOURCE_R0028: {
      ...dynamicError,
      fix: "Pass `array()` field paths as non-empty strings in `filters`, `search`, `facets`, `key`, and `sort.field`. Do not name a filter `cursor`, `empty`, `limit`, or `search`.",
    },
    SOURCE_R0029: {
      ...dynamicError,
      fix: "Use `orderBy` columns of `table()` that store numbers, strings, booleans, or dates.",
    },
    SOURCE_R0030: {
      ...dynamicError,
      fix: "Use `orderBy.column` and `orderBy.tieBreaker` columns from the table that you pass to `table()`.",
    },
    SOURCE_R0031: {
      ...dynamicError,
      fix: "Use `orderBy` columns of `table()` whose values the database stores as a number, a string, or a boolean.",
    },
    SOURCE_R0032: {
      ...dynamicError,
      fix: "Use `orderBy` columns of `table()` that have `.notNull()` in the Drizzle schema.",
    },
    SOURCE_R0033: {
      ...dynamicError,
      fix: "Use a primary key or a `.unique()` column as `orderBy.tieBreaker` of `table()`, such as the `id` column.",
    },
    SOURCE_R0034: {
      why: ({ endpoint, status }: { endpoint: string; status: number }) => `[vitehub] Collection request to ${endpoint} failed with status ${status}.`,
      fix: "Check the Collection route and server logs for this HTTP status, correct the request or server error, then refresh the Collection.",
    },
    SOURCE_B0001: {
      ...dynamicError,
      fix: "Remove the server route that answers the route that the message names. To keep your route, turn off the generated one: set `route: false` in the Collection or in `defineContent()`, or turn off the `seo` option of server/content.ts that adds it.",
    },
    SOURCE_B0002: {
      ...dynamicError,
      fix: "Remove the handler for the route that the message names from the Nitro `handlers` config, or from `serverHandlers` in Nuxt. To keep it, turn off the generated route: set `route: false` in the Collection or in `defineContent()`, or turn off the `seo` option of server/content.ts that adds it.",
    },
    SOURCE_B0003: {
      ...dynamicError,
      fix: "Rename the Collection file under server/collections/ to a valid JavaScript identifier, such as `posts.ts` or `blog_posts.ts`, without dashes, dots, or a leading digit.",
    },
    SOURCE_B0004: {
      ...dynamicError,
      fix: "Export the Collection from the file with the same name as the file: `export const posts = defineCollection(...)` in server/collections/posts.ts.",
    },
    SOURCE_B0005: {
      ...dynamicError,
      fix: "Keep each Collection name in one server directory. Rename or remove the file under server/collections/ in one of the server directories, such as a Nuxt layer.",
    },
    SOURCE_B0006: {
      ...dynamicError,
      fix: "Rename one of the two Collection files under server/collections/, so that the names are different also when you ignore the letter case.",
    },
    SOURCE_B0007: {
      ...dynamicError,
      fix: "Keep one Content file. Remove the other server/content.ts files from the other server directories, such as a Nuxt layer.",
    },
    SOURCE_B0008: {
      ...dynamicError,
      fix: "Write `export default defineContent({ ... })` in the Content file that the message names.",
    },
    SOURCE_B0009: {
      ...dynamicError,
      fix: "Write `export default defineContent({ ... })` in server/content.ts. Run `npx @vite-hub/codemods define-forms` to move the export and the imports of it.",
    },
    SOURCE_B0010: {
      why: ({ route, other }: { route: string, other: string }) => `[vitehub] defineContent({ seo: { mcp } }) serves its MCP server at ${JSON.stringify(route)}, and ${other} answers there too.`,
      fix: "One route serves one MCP server. Give the app MCP server another route, such as `vitehub({ mcp: { route: '/mcp/app' } })`, or another `publicRoute`. Or set `seo: { mcp: false }` in server/content.ts.",
    },
    // Named errors. Keep these codes in alphabetical order.
    SOURCE_GITHUB_ARCHIVE_INVALID: {
      why: "[vitehub] The archive of the github() Source has an entry with an invalid size.",
      fix: "Load the Source again: GitHub or `git archive` sent a cut or broken archive. If it fails again, check the network and that the ref of the `github()` Source exists.",
    },
    SOURCE_GLOB_OPTIONS_NOT_LITERAL: {
      why: "glob() here takes options that are not literals, so the build cannot bundle its files. It reads them from disk at runtime, which hosts such as Cloudflare Workers do not have.",
      fix: "Write the options of `glob()` as literals in the call, such as `glob({ cwd: \"content\", include: [\"**/*.md\"] })`, so the build can find and bundle the files.",
    },
  },
})
