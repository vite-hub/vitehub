import type { DocsLane } from "~~/modules/vitehub-docs/docs-lanes";
import { getDocsPageByPath, type DocsPage } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  docsLaneOptions,
  getDocsLaneTarget,
  getDocsPageTarget,
  resolveDocsLane,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const docsLaneCookie = "vitehub-docs-lane";

export function useDocsLane() {
  const route = useRoute();
  const persistedLane = useCookie<DocsLane | null>(docsLaneCookie, {
    default: () => null,
    sameSite: "lax",
  });
  const currentPage = computed(() => getDocsPageByPath(route.path));
  const lane = computed(() => resolveDocsLane({
    path: route.path,
    page: currentPage.value,
    queryLane: route.query.lane,
    persistedLane: persistedLane.value,
  }));

  if (import.meta.client) {
    watch(lane, (nextLane) => {
      persistedLane.value = nextLane;
    }, { immediate: true });
  }

  function laneTarget(targetLane: DocsLane) {
    return {
      ...getDocsLaneTarget({
        lane: targetLane,
        path: route.path,
        page: currentPage.value,
        query: route.query,
      }),
      hash: currentPage.value?.lanes.includes(targetLane) ? route.hash : undefined,
    };
  }

  function pageTarget(page: DocsPage) {
    return getDocsPageTarget(page, lane.value);
  }

  return {
    lane,
    laneOptions: docsLaneOptions,
    laneTarget,
    pageTarget,
  };
}
