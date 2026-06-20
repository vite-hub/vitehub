<script setup lang="ts">
const route = useRoute();
const { subNavigationMode, sections } = useSubNavigation();
const isBetterAuthFixture = computed(() => route.path.includes("/docs/getting-started/better-auth-style"));

const sectionOrder = [
  "Start",
  "Concepts",
  "Agents",
  "Capabilities",
  "Server primitives",
  "Development",
  "Frameworks and Hosts",
  "Reference",
  "AI Resources",
];

const orderedSections = computed(() => {
  return [...sections.value].sort((a, b) => {
    const aIndex = sectionOrder.indexOf(a.label);
    const bIndex = sectionOrder.indexOf(b.label);

    return (aIndex === -1 ? sectionOrder.length : aIndex)
      - (bIndex === -1 ? sectionOrder.length : bIndex);
  });
});
</script>

<template>
  <div v-if="isBetterAuthFixture" class="better-auth-sidebar-head">
    <button type="button" class="better-auth-version-row">
      <span class="better-auth-version-icon" aria-hidden="true" />
      <span>v1.6 (Latest)</span>
      <UIcon name="i-lucide-chevrons-up-down" class="ml-auto size-3.5 text-muted" />
    </button>

    <UContentSearchButton
      :collapsed="false"
      class="better-auth-sidebar-search"
      :ui="{
        base: 'rounded-none border-0 border-b border-default px-4 text-muted hover:text-highlighted',
        trailing: 'ms-auto flex items-center gap-1',
      }"
    />
  </div>

  <div v-else class="border-b border-default">
    <UButton
      label="v0.0 (dev)"
      trailing-icon="i-lucide-chevron-down"
      color="neutral"
      variant="ghost"
      block
      class="h-10 justify-between rounded-none px-4 text-muted"
    />
    <UContentSearchButton :collapsed="false" />
  </div>

  <div
    v-if="subNavigationMode === 'aside' && !isBetterAuthFixture"
    class="border-b border-default py-2"
  >
    <NuxtLink
      to="/docs/"
      class="flex min-h-8 items-center gap-3 px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-highlighted"
    >
      <UIcon name="i-lucide-book-open" class="size-4 shrink-0" />
      <span>Start</span>
    </NuxtLink>

    <UPageAnchors :links="orderedSections" />
  </div>
</template>
