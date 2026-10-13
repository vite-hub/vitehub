import { defineNuxtRouteMiddleware, navigateTo } from "#imports";
import { docsLegacyFragmentRedirects } from "~~/modules/vitehub-docs/redirects";

export default defineNuxtRouteMiddleware((to) => {
  const fragment = to.hash.slice(1);
  const path = to.path.replace(/\/+$/, "");
  // SAFETY: Route paths are runtime strings, and unknown paths must resolve to no redirects.
  const redirects = docsLegacyFragmentRedirects[path as keyof typeof docsLegacyFragmentRedirects];
  // SAFETY: Unknown fragments must resolve to no redirects, so indexing the known fragment map is safe.
  const target = redirects?.[fragment as keyof typeof redirects];

  if (!target || target === to.path) return;

  return navigateTo({ path: target, hash: `#${fragment}` }, { replace: true });
});
