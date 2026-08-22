import type { H3Error, H3Event } from "h3";
import {
  getRequestHeader,
  getRequestURL,
  getResponseHeader,
  send,
  setResponseHeader,
  setResponseHeaders,
  setResponseStatus,
} from "h3";
import {
  acceptsAgentFriendlyError,
  notFoundMarkdown,
  withVary,
} from "./utils/markdown-negotiation";

export default function agentFriendlyErrorHandler(error: H3Error, event: H3Event) {
  const statusCode = error.statusCode || 500;
  if (statusCode !== 404) return;

  const vary = withVary(getResponseHeader(event, "vary")?.toString(), "Accept");
  setResponseHeader(event, "vary", vary);
  if (!acceptsAgentFriendlyError(getRequestHeader(event, "accept"))) return;

  setResponseStatus(event, 404, error.statusMessage || "Page not found");
  setResponseHeaders(event, {
    "cache-control": "no-cache",
    "content-type": "text/markdown; charset=utf-8",
    "vary": vary,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex",
  });

  return send(event, notFoundMarkdown(getRequestURL(event).pathname));
}
