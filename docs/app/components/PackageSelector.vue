<script setup lang="ts">
import { useRoute } from "#app/composables/router";
import { computed } from "vue";
import { useFrameworkPreference } from "../composables/useFrameworkPreference";
import { docsManifest, getDocsPath, getDocsPathMeta } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { normalizeSitePath } from "~~/modules/vitehub-docs/runtime/utils/docs-routes";

type PackageLink = {
  label: string;
  icon?: string;
  to: string;
  active: boolean;
};

const route = useRoute();
const { current } = useFrameworkPreference();

const normalizedRoutePath = computed(() => normalizeSitePath(route.path));
const routeMeta = computed(() => getDocsPathMeta(normalizedRoutePath.value));
const isDocsRoute = computed(() => normalizedRoutePath.value === "/docs" || normalizedRoutePath.value.startsWith("/docs/"));

const packageLinks = computed(() => {
  const links: PackageLink[] = [];

  for (const sectionMeta of docsManifest.packageSections) {
    const section = docsManifest.sections.find(item => item.id === sectionMeta.id);
    const pages = section?.pages.filter(page => page.frameworks.includes(current.value)) || [];
    const primaryPage = pages.find(page => page.id === "index")
      || pages[0];

    if (!section || !primaryPage) {
      continue;
    }

    const to = getDocsPath(sectionMeta.id, current.value, primaryPage.id);
    const active = routeMeta.value?.section === sectionMeta.id;

    links.push({
      label: sectionMeta.title,
      icon: sectionMeta.icon || undefined,
      to,
      active,
    });
  }

  return links;
});

const activePackage = computed(() => {
  return packageLinks.value.find(link => link.active) || null;
});

const items = computed(() => [
  {
    label: activePackage.value?.label || "Packages",
    icon: activePackage.value?.icon || "i-lucide-box",
    value: "packages",
    children: packageLinks.value.map(link => ({
      label: link.label,
      icon: link.icon,
      to: link.to,
      active: link.active,
    })),
  },
]);
</script>

<template>
  <UNavigationMenu
    v-if="isDocsRoute && packageLinks.length"
    :items="items"
    disable-hover-trigger
    class="hidden lg:flex"
    :ui="{
      content: 'min-w-56 w-max',
      childLink: 'min-w-full w-max whitespace-nowrap',
      childLinkLabel: 'overflow-visible text-clip whitespace-nowrap',
    }"
  />
</template>
