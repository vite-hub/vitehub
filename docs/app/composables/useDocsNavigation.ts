import { useRoute } from "#app/composables/router";
import { computed } from "vue";
import { useFrameworkPreference } from "./useFrameworkPreference";
import {
  buildDocsSidebarNavigation,
  getDocsActiveSection,
  getSupportedDocsSections,
} from "~~/modules/vitehub-docs/runtime/utils/docs-rendering";
import { normalizeSitePath } from "~~/modules/vitehub-docs/runtime/utils/docs-routes";

export function useDocsNavigation() {
  const route = useRoute();
  const { current } = useFrameworkPreference();
  const normalizedRoutePath = computed(() => normalizeSitePath(route.path));

  const sections = computed(() => getSupportedDocsSections(current.value));
  const activeSection = computed(() => getDocsActiveSection(normalizedRoutePath.value, sections.value));
  const sidebarNavigation = computed(() => buildDocsSidebarNavigation(normalizedRoutePath.value, current.value, sections.value));

  return {
    sections,
    activeSection,
    sidebarNavigation,
  };
}
