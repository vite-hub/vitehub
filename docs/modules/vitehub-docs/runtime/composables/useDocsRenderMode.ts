import { computed } from "vue";
import { useRoute } from "#imports";
import type { DocsRenderOptions } from "../utils/framework-content";

export function useDocsRenderMode() {
  const route = useRoute();
  const enabled = computed(() => import.meta.dev && route.path.startsWith("/docs/"));
  const renderMode = computed<DocsRenderOptions["renderMode"]>(() => enabled.value ? "all" : "single");

  return {
    enabled,
    renderMode,
  };
}
