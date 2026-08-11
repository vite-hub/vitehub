import type { DocsLane } from "~~/modules/vitehub-docs/docs-lanes";
import { getDocsPageByPath, type DocsPage } from "~~/modules/vitehub-docs/runtime/utils/docs";
import {
  docsLaneOptions,
  getDocsLaneSelectionTarget,
  getDocsPageTarget,
  resolveDocsLane,
} from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

const docsLaneCookie = "vitehub-docs-lane";

export function useDocsLane() {
  const route = useRoute();
  const router = useRouter();
  const persistedLane = useCookie<DocsLane | null>(docsLaneCookie, {
    default: () => null,
    sameSite: "lax",
  });
  const currentPage = computed(() => getDocsPageByPath(route.path));
  const resolveLane = () => resolveDocsLane({
    path: route.path,
    page: currentPage.value,
    queryLane: route.query.lane,
    persistedLane: persistedLane.value,
  });
  const lane = useState<DocsLane>(docsLaneCookie, resolveLane);

  if (import.meta.client) {
    watch([() => route.path, () => route.query.lane], () => {
      lane.value = resolveLane();
    });
    watch(lane, (nextLane) => {
      persistedLane.value = nextLane;
    }, { immediate: true });
  }

  function selectLane(targetLane: DocsLane) {
    lane.value = targetLane;

    const target = getDocsLaneSelectionTarget({
      hash: route.hash,
      lane: targetLane,
      page: currentPage.value,
      path: route.path,
      query: route.query,
    });

    if (target) {
      void router.replace(target);
    }
  }

  function pageTarget(page: DocsPage) {
    return getDocsPageTarget(page, lane.value);
  }

  return {
    lane,
    laneOptions: docsLaneOptions,
    pageTarget,
    selectLane,
  };
}
