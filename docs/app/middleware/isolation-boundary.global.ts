import { defineNuxtRouteMiddleware, navigateTo } from "#imports";
import { isIsolatedPath } from "~/utils/runnable-tutorial";

// `/learn` pages and `/playground` are cross-origin isolated and other pages are not. The headers come with the document, so a
// client-side navigation across the boundary would keep the wrong ones. Load a new document instead.
export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.server || to.path === from.path) return;
  if (isIsolatedPath(to.path) !== isIsolatedPath(from.path)) return navigateTo(to.fullPath, { external: true });
});
