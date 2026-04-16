import { useSeoMeta } from "#app/composables/head";
import { computed, type ComputedRef, type Ref } from "vue";
import { useDocsRenderMode } from "./useDocsRenderMode";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { useUsageModePreference } from "./useUsageModePreference";
import { normalizeFrameworkPage, type NormalizedPage } from "~~/modules/vitehub-docs/runtime/utils/framework-content";

export type ContentPage = NormalizedPage & {
  data?: Record<string, unknown>;
  title?: string;
  description?: string;
  seo?: { title?: string; description?: string };
  toc?: unknown;
};

export function useDocsPage(sourcePath: string | ComputedRef<string>, rawDoc: Ref<Record<string, any> | null | undefined>, fallback: { title: string; sourceTitle: string | null; description: string | null }) {
  const { current: framework } = useFrameworkPreference();
  const { current: mode } = useUsageModePreference();
  const { renderMode } = useDocsRenderMode();

  const path = typeof sourcePath === "string" ? computed(() => sourcePath) : sourcePath;

  const sourcePage = computed<ContentPage>(() => {
    const doc = rawDoc.value;
    const title = String(doc?.title || fallback.sourceTitle || fallback.title);
    const description = doc?.description || fallback.description || undefined;
    return {
      path: path.value,
      title,
      description,
      seo: { title: doc?.seo?.title || title, description: doc?.seo?.description || description },
      data: doc?.meta || {},
      body: doc?.body ? { ...doc.body, toc: doc.body?.toc || null } : null,
    };
  });

  const page = computed(() => normalizeFrameworkPage(sourcePage.value, {
    framework: framework.value,
    mode: mode.value,
    renderMode: renderMode.value,
    tocMode: "current-selection",
  }) as ContentPage);

  useSeoMeta({
    title: () => page.value?.seo?.title || page.value?.title || undefined,
    ogTitle: () => page.value?.seo?.title || page.value?.title || undefined,
    description: () => page.value?.seo?.description || page.value?.description || undefined,
    ogDescription: () => page.value?.seo?.description || page.value?.description || undefined,
  });

  return { page, framework, mode };
}
