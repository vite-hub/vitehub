import { computed, nextTick } from "vue";
import { useCookie } from "#imports";
import {
  defaultUsageMode,
  usageModes,
  type UsageMode,
} from "~~/modules/vitehub-docs/runtime/utils/fw-variants";

export function useUsageModePreference() {
  const cookie = useCookie<UsageMode>("vitehub-mode", {
    default: () => defaultUsageMode,
    maxAge: 60 * 60 * 24 * 365,
  });

  const current = computed<UsageMode>(() => {
    return usageModes.includes(cookie.value as UsageMode)
      ? cookie.value as UsageMode
      : defaultUsageMode;
  });

  async function switchTo(mode: UsageMode) {
    cookie.value = mode;

    if (!import.meta.client) {
      return;
    }

    const scrollY = window.scrollY;
    await nextTick();
    window.scrollTo(0, scrollY);
  }

  return {
    current,
    cookie,
    switchTo,
  };
}

export const useUsageMode = useUsageModePreference;
