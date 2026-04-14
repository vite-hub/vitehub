import { z } from "zod";
import { getDocsDocument, getDocsPathMeta, getDocsPage } from "~~/modules/vitehub-docs/runtime/utils/docs";

export default defineMcpTool({
  description: "Retrieves the full markdown content of a specific documentation page by path.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    path: z.string().describe("The page path (e.g., /docs/nuxt/getting-started)"),
  },
  cache: "1h",
  handler: async ({ path }) => {
    const event = useEvent();
    const origin = getRequestURL(event).origin;
    const meta = getDocsPathMeta(path);

    if (!meta) {
      throw createError({ statusCode: 404, message: "Page not found" });
    }

    const page = getDocsPage(meta.section, meta.page);
    const content = getDocsDocument(path);

    if (!page || !content) {
      throw createError({ statusCode: 404, message: "Page not found" });
    }

    return { title: page.title, path, description: page.description, content, url: `${origin}${path}` };
  },
});
