import { computed, nextTick } from "vue";
import { navigateTo, useCookie, useRoute } from "#imports";
import { normalizeSitePath, resolveFrameworkSwitchPath } from "../utils/docs-routes";
import { defaultFramework, frameworks, type Framework } from "../utils/frameworks";

export function useFrameworkPreference() {
  const route = useRoute();
  const cookie = useCookie<Framework>("vitehub-fw", {
    default: () => defaultFramework,
    maxAge: 60 * 60 * 24 * 365,
  });
  const normalizedRoutePath = computed(() => normalizeSitePath(route.path));

  const current = computed<Framework>(() => {
    const segment = normalizedRoutePath.value.split("/")[2];
    if (segment && frameworks.includes(segment as Framework)) {
      return segment as Framework;
    }

    return cookie.value || defaultFramework;
  });

  async function switchTo(framework: Framework) {
    cookie.value = framework;

    if (!import.meta.client) {
      return;
    }

    const scrollY = window.scrollY;
    const nextPath = resolveFrameworkSwitchPath(normalizedRoutePath.value, framework);
    if (nextPath !== normalizedRoutePath.value) {
      await navigateTo(nextPath);
    }

    await nextTick();
    window.scrollTo(0, scrollY);
  }

  return {
    current,
    cookie,
    switchTo,
  };
}

export const useFramework = useFrameworkPreference;
