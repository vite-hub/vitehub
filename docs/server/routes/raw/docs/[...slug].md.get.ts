import { getDocsDocument } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { resolveRawDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs-routes";

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, "slug");
  const rawPath = `/raw/docs/${slug}.md`;
  const docsPath = resolveRawDocsPath(rawPath);

  if (!docsPath) {
    throw createError({ statusCode: 404, statusMessage: "Page not found" });
  }

  const source = getDocsDocument(docsPath);
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: "Page not found" });
  }

  setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
  return source;
});
