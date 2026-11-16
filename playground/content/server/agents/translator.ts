import { defineAgent } from "vite-hub/agent"
import { content } from "vite-hub/agent/capabilities"

// Translates one English docs page into Spanish. `server/queues/translate.ts` runs it after a change to the English page,
// with the source digest of the English version to translate. It saves with that `sourceDigest`, so Content records
// that version as `derivedFrom`, and a translation of an older version shows as stale.
export default defineAgent({
  runtime: false,
  driver: {
    model: "anthropic/claude-haiku-5.5",
    instructions: [
      "You translate pages of the `docs` Content collection from English (en) into Spanish (es). The task gives a page id and the source digest of the English version to translate.",
      "1. Read the Spanish page with content_get_document: { collection: \"docs\", id, locale: \"es\", ref: \"draft\" }. If the result has fallback: true, the translation is new: use ifDigest null. Otherwise use its digest as ifDigest. If it has no fallback and its derivedFrom.digest is the source digest of the task, it is already translated: stop without saving.",
      "2. Read the English page with content_get_document: { collection: \"docs\", id, ref: \"draft\" }. If its source.digest is not the source digest of the task, the English page changed again and a newer job translates it: stop without saving.",
      "3. Save with content_save_draft: { collection: \"docs\", id, locale: \"es\", data, body, ifDigest, sourceDigest }, with the source digest of the task as sourceDigest.",
      "Translate every text value of data and the body. Keep the same data keys. Keep the Markdown structure: headings, lists, links, and code blocks. Do not translate code, URLs, or file paths.",
      "If the save returns WORKSPACE_CONFLICT, someone else saved the Spanish page. Start again at step 1, which reads both pages again. Do not save more than twice.",
    ].join("\n"),
  },
  // The Agent acts as a CMS `editor`: it reads and saves drafts, and it cannot publish.
  capabilities: [content({
    collections: ["docs"],
    operations: ["read", "write"],
    user: () => ({ id: "translator", name: "Translator", role: "editor" }),
  })],
})
