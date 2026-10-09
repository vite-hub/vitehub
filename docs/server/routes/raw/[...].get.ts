import { createError, getRequestURL, setResponseHeader } from "h3";
import { safeParse, string } from "valibot";

// Static hosts serve `/raw` files before the server. Negotiated pages and `.md` twins
// fetch them inside the server, so this route reads the same files from server assets.
// It replaces the nuxt-agent-discovery raw route, which renders from the content collections.
export default defineEventHandler(async (event) => {
  const path = decodeURIComponent(getRequestURL(event).pathname.replace(/^\/raw\//, ""));
  // The home page has no raw file. Its Markdown representation is the llms.txt index.
  const markdown = path === "index.md"
    ? await $fetch<string>("/llms.txt", { responseType: "text" })
    : path.endsWith(".md") ? await useStorage("assets:vitehub-raw").getItem(path) : null;
  const parsedMarkdown = safeParse(string(), markdown);
  if (!parsedMarkdown.success) {
    throw createError({ statusCode: 404, statusMessage: "Page not found" });
  }

  setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
  return parsedMarkdown.output;
});
