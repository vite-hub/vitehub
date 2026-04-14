import { getDocsDocument } from "~~/modules/vitehub-docs/runtime/utils/docs";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const path = typeof query.path === "string" ? query.path : "";

  if (!path) {
    throw createError({ statusCode: 400, statusMessage: "Missing docs path" });
  }

  const sourceDocument = getDocsDocument(path);

  if (!sourceDocument) {
    throw createError({ statusCode: 404, statusMessage: "Page not found" });
  }

  const parsed = await parseMarkdown(sourceDocument);

  return {
    title: typeof parsed.data?.title === "string" ? parsed.data.title : undefined,
    description: typeof parsed.data?.description === "string" ? parsed.data.description : undefined,
    seo: {
      title: typeof parsed.data?.title === "string" ? parsed.data.title : undefined,
      description: typeof parsed.data?.description === "string" ? parsed.data.description : undefined,
    },
    body: parsed.body,
    toc: parsed.toc || null,
    data: parsed.data || {},
  };
});
