import { computed, type ComputedRef, type Ref } from "vue";
import { useSeoMeta } from "#imports";
import { useDocsRenderMode } from "./useDocsRenderMode";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { useUsageModePreference } from "./useUsageModePreference";
import { normalizeFrameworkPage, type NormalizedPage } from "../utils/framework-content";

export type ContentPage = NormalizedPage & {
  data?: Record<string, unknown>;
  title?: string;
  description?: string;
  seo?: { title?: string; description?: string };
  toc?: unknown;
};

export function useDocsPage(sourcePath: string | ComputedRef<string>, rawDoc: Ref<Record<string, any> | null>, fallback: { title: string; sourceTitle: string | null; description: string | null }) {
  const { current: framework } = useFrameworkPreference();
  const { current: mode } = useUsageModePreference();
  const { renderMode } = useDocsRenderMode();

  const path = typeof sourcePath === "string" ? computed(() => sourcePath) : sourcePath;

  const sourcePage = computed<ContentPage>(() => ({
    path: path.value,
    title: String(rawDoc.value?.title || fallback.sourceTitle || fallback.title),
    description: rawDoc.value?.description || fallback.description || undefined,
    seo: {
      title: rawDoc.value?.seo?.title || rawDoc.value?.title || fallback.sourceTitle || fallback.title,
      description: rawDoc.value?.seo?.description || rawDoc.value?.description || fallback.description || undefined,
    },
    data: rawDoc.value?.data || {},
    body: rawDoc.value?.body ? { ...rawDoc.value.body, toc: rawDoc.value.toc || null } : null,
  }));

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
