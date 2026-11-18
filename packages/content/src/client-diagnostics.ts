import { defineDiagnostics } from "nostics"

// The codes that `vite-hub/content/client` raises in the browser, so a page does not load the whole Content catalog.
export const contentClientDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/content/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    CONTENT_FIELD_ADDRESS_INVALID: {
      why: ({ part, value }: { part: "collection name" | "document id" | "field path", value: string }) => `[vitehub] ${JSON.stringify(value)} is not a Content ${part}.`,
      fix: "Pass `contentField()` or `formatContentField()` a collection name that starts with a letter, `_`, or `$`, a document id without `#`, and a field path with dots between keys, such as `hero.title`.",
    },
  },
})
