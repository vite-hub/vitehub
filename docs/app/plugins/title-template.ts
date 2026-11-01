import { defineNuxtPlugin, useHead } from "#imports";

// One title pattern for every page: "KV configuration · ViteHub". A title that already names ViteHub stays as written,
// so "About ViteHub" does not become "About ViteHub · ViteHub". The high priority replaces the Docus "%s - ViteHub" template.
export default defineNuxtPlugin(() => {
  useHead({
    titleTemplate: (title) => {
      if (!title) return "ViteHub";
      return title.includes("ViteHub") ? title : `${title} · ViteHub`;
    },
  }, { tagPriority: "high" });
});
