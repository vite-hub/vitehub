import { createError, getRequestHeader, getRequestURL, getResponseHeader, setResponseHeader } from "h3";
import { acceptsMarkdown, markdownRouteForPath, withVary } from "../utils/markdown-negotiation";

export default defineEventHandler(async (event) => {
  const markdownRoute = markdownRouteForPath(getRequestURL(event).pathname);
  if (!markdownRoute) return;

  const currentVary = getResponseHeader(event, "vary")?.toString();
  setResponseHeader(event, "vary", withVary(currentVary, "Accept"));

  if ((event.method !== "GET" && event.method !== "HEAD") || !acceptsMarkdown(getRequestHeader(event, "accept"))) return;

  try {
    const markdown = await $fetch<string>(markdownRoute, { responseType: "text" });
    setResponseHeader(event, "content-type", "text/markdown; charset=utf-8");
    return markdown;
  }
  catch (error) {
    const statusCode = (error as { response?: { status?: number } }).response?.status;
    if (statusCode === 404) {
      throw createError({ statusCode: 404, statusMessage: "Page not found" });
    }
    throw error;
  }
});
