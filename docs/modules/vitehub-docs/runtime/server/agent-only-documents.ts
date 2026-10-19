import { unwrapAgentOnlyDocument } from "../utils/agent-only";

// llms-full.txt and the MCP `get-page` tool build Markdown from the content tree, not from `/raw`.
// Unwrap `::agent-only` there too, so every agent path gets the same text as `/raw/<page>.md`.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("agent-discovery:document", (_event, page: unknown) => {
    unwrapAgentOnlyDocument(page);
  });
});
