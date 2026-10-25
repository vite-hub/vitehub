import { createError, defineEventHandler, setHeader } from "h3";
import { checkOrigin, requireOwner } from "../utils/session";

export default defineEventHandler(async (event) => {
  const path = event.path.split("?")[0] || "/";
  // The app owns its chat API. Generated Agent endpoints must not bypass it.
  if (/^\/(?:api\/)?_+vitehub(?:\/|$)/.test(path)) {
    throw createError({ statusCode: 404 });
  }
  if (!path.startsWith("/api/")) return;
  setHeader(event, "cache-control", "no-store");
  if (!["GET", "HEAD"].includes(event.method)) checkOrigin(event);
  if (path !== "/api/session") await requireOwner(event);
});
