import { refreshCookie, useCookie } from "#app/composables/cookie";
import { navigateTo, useRoute } from "#app/composables/router";
import { useState } from "#app/composables/state";
import { computed, nextTick, onMounted, watch } from "vue";
import { normalizeSitePath, resolveFrameworkSwitchPath } from "~~/modules/vitehub-docs/runtime/utils/docs-routes";
import { defaultFramework, frameworks, type Framework, visibleFrameworks } from "~~/modules/vitehub-docs/runtime/utils/frameworks";

export function useFrameworkPreference() {
  const route = useRoute();
  const cookie = useCookie<Framework>("vitehub-fw", {
    default: () => defaultFramework,
    maxAge: 60 * 60 * 24 * 365,
  });
  const stored = useState<Framework>("vitehub-fw-state", () => defaultFramework);
  const cookieReady = useState<boolean>("vitehub-fw-ready", () => false);
  const normalizedRoutePath = computed(() => normalizeSitePath(route.path));
  const routeFramework = computed<Framework | null>(() => {
    const segment = normalizedRoutePath.value.split("/")[2];
    if (segment && frameworks.includes(segment as Framework)) {
      return segment as Framework;
    }

    return null;
  });

  const current = computed<Framework>(() => {
    if (routeFramework.value) {
      return routeFramework.value;
    }

    if (visibleFrameworks.includes(stored.value as Framework)) {
      return stored.value as Framework;
    }

    if (visibleFrameworks.includes(cookie.value as Framework)) {
      return cookie.value as Framework;
    }

    return defaultFramework;
  });

  watch(routeFramework, (framework) => {
    if (!framework) {
      return;
    }

    if (stored.value !== framework) {
      stored.value = framework;
    }

    if (cookie.value !== framework) {
      cookie.value = framework;
    }
  }, { immediate: true });

  watch(cookie, (framework) => {
    if (!cookieReady.value) {
      return;
    }

    if (framework && frameworks.includes(framework as Framework) && stored.value !== framework) {
      stored.value = framework as Framework;
    }
  });

  onMounted(() => {
    refreshCookie("vitehub-fw");

    if (visibleFrameworks.includes(cookie.value as Framework)) {
      stored.value = cookie.value as Framework;
    }

    cookieReady.value = true;
  });

  async function switchTo(framework: Framework) {
    stored.value = framework;
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
    switchTo,
  };
}
