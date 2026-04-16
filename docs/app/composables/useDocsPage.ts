import { useSeoMeta } from "#app/composables/head";
import { computed, type ComputedRef, type Ref } from "vue";
import { useDocsRenderMode } from "./useDocsRenderMode";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { useUsageModePreference } from "./useUsageModePreference";
import type { DocsCollectionItem } from "@nuxt/content";
import { normalizeFrameworkPage } from "~~/modules/vitehub-docs/runtime/utils/framework-content";

export type ContentPage = DocsCollectionItem & {
  data?: Record<string, unknown>;
  seo?: { title?: string; description?: string };
};

export function useDocsPage(sourcePath: string | ComputedRef<string>, rawDoc: Ref<DocsCollectionItem | null | undefined>, fallback: { title: string; sourceTitle: string | null; description: string | null }) {
  const { current: framework } = useFrameworkPreference();
  const { current: mode } = useUsageModePreference();
  const { renderMode } = useDocsRenderMode();

  const path = typeof sourcePath === "string" ? computed(() => sourcePath) : sourcePath;

  const sourcePage = computed(() => {
    const doc = rawDoc.value;
    if (!doc) return null;
    const title = String(doc.title || fallback.sourceTitle || fallback.title);
    const description = doc.description || fallback.description || "";
    return {
      ...doc,
      path: path.value,
      title,
      description,
      seo: { title: doc.seo?.title || title, description: doc.seo?.description || description },
      data: doc.meta || {},
    } satisfies ContentPage;
  });

  const page = computed<ContentPage | null>(() => normalizeFrameworkPage(sourcePage.value, {
    framework: framework.value,
    mode: mode.value,
    renderMode: renderMode.value,
    tocMode: "current-selection",
  }));

  useSeoMeta({
    title: () => page.value?.seo?.title || page.value?.title || undefined,
    ogTitle: () => page.value?.seo?.title || page.value?.title || undefined,
    description: () => page.value?.seo?.description || page.value?.description || undefined,
    ogDescription: () => page.value?.seo?.description || page.value?.description || undefined,
  });

  return { page, framework, mode };
}
