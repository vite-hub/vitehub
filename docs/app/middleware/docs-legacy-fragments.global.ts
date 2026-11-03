import { defineNuxtRouteMiddleware, navigateTo } from "#imports";
import { docsLegacyFragmentRedirects } from "~~/modules/vitehub-docs/redirects";

export default defineNuxtRouteMiddleware((to) => {
  const fragment = to.hash.slice(1);
  const path = to.path.replace(/\/+$/, "");
  // Route paths and fragments are runtime strings. An unknown one resolves to no redirect.
  const redirects: Partial<Record<string, Partial<Record<string, string>>>> = docsLegacyFragmentRedirects;
  const target = redirects[path]?.[fragment];

  if (!target) return;

  const [targetPath, targetFragment = fragment] = target.split("#", 2);
  if (targetPath === to.path && targetFragment === fragment) return;

  return navigateTo({ path: targetPath, hash: `#${targetFragment}` }, { replace: true });
});
