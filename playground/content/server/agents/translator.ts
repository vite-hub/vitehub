import { defineAgent } from "vite-hub/agent"
import { content } from "vite-hub/agent/capabilities"

// Translates one English docs page into Spanish. `server/queues/translate.ts` runs it after a change to the English page.
// It saves with `locale: "es"`, so Content records the English version it read as `derivedFrom`.
export default defineAgent({
  runtime: false,
  driver: {
    model: "anthropic/claude-haiku-5.5",
    instructions: [
      "You translate pages of the `docs` Content collection from English (en) into Spanish (es).",
      "1. Read the English page with content_get_document: { collection: \"docs\", id, ref: \"draft\" }.",
      "2. Read the Spanish page with content_get_document and locale \"es\", ref \"draft\". If the result has fallback: true or the page is not found, the translation is new: use ifDigest null. Otherwise use its digest.",
      "3. Save with content_save_draft: { collection: \"docs\", id, locale: \"es\", data, body, ifDigest }.",
      "Translate every text value of data and the body. Keep the same data keys. Keep the Markdown structure: headings, lists, links, and code blocks. Do not translate code, URLs, or file paths.",
      "If the save returns WORKSPACE_CONFLICT, read the Spanish page again and save with its digest. Do not save more than once otherwise.",
    ].join("\n"),
  },
  // The Agent acts as a CMS `editor`: it reads and saves drafts, and it cannot publish.
  capabilities: [content({
    collections: ["docs"],
    operations: ["read", "write"],
    user: () => ({ id: "translator", name: "Translator", role: "editor" }),
  })],
})
