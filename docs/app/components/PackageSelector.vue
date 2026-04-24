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
  packageLinks.value.map(link => ({
    label: link.label,
    icon: link.icon,
    to: link.to,
    active: link.active,
  })),
]);
</script>

<template>
  <UDropdownMenu
    v-if="isDocsRoute && packageLinks.length"
    :items="items"
    class="hidden lg:flex"
    :content="{ align: 'end', sideOffset: 8 }"
    :ui="{
      content: 'min-w-56',
      itemLabel: 'overflow-visible text-clip whitespace-nowrap',
    }"
  >
    <UButton
      :label="activePackage?.label || 'Packages'"
      :icon="activePackage?.icon || 'i-lucide-box'"
      trailing-icon="i-lucide-chevron-down"
      color="neutral"
      variant="soft"
      class="hidden lg:inline-flex"
    />
  </UDropdownMenu>
</template>
