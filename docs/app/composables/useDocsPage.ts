import { useSeoMeta } from "#app/composables/head";
import { computed, type ComputedRef, type Ref } from "vue";
import type { DocsCollectionItem } from "@nuxt/content";
import { renderDocsPage, type DocsPageFallback, type DocsPageState } from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";

export type ContentPage = DocsPageState<DocsCollectionItem>;

export function useDocsPage(sourcePath: string | ComputedRef<string>, rawDoc: Ref<DocsCollectionItem | null | undefined>, fallback: DocsPageFallback) {
  const path = typeof sourcePath === "string" ? computed(() => sourcePath) : sourcePath;

  const page = computed<ContentPage | null>(() => renderDocsPage(rawDoc.value, path.value, fallback));

  useSeoMeta({
    title: () => page.value?.seo?.title || page.value?.title || undefined,
    ogTitle: () => page.value?.seo?.title || page.value?.title || undefined,
    description: () => page.value?.seo?.description || page.value?.description || undefined,
    ogDescription: () => page.value?.seo?.description || page.value?.description || undefined,
  });

  return { page };
}
