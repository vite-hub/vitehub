<script setup lang="ts">
const { subNavigationMode, sections } = useSubNavigation();

const sectionOrder = ["Getting started", "Server primitives", "Agents"];

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
  <div class="mb-6 border-b border-dashed border-default pb-4">
    <p class="text-xs font-semibold uppercase tracking-wider text-muted">
      Documentation
    </p>
    <p class="mt-1 text-sm text-default">
      Server primitives and agents.
    </p>
  </div>

  <div
    v-if="subNavigationMode === 'aside'"
    class="mb-4"
  >
    <NuxtLink
      to="/docs/"
      class="mb-2 flex min-h-8 items-center gap-3 text-sm font-medium text-muted transition-colors hover:text-highlighted"
    >
      <UIcon name="i-lucide-book-open" class="size-4 shrink-0" />
      <span>Start</span>
    </NuxtLink>

    <UPageAnchors :links="orderedSections" />
    <USeparator
      type="dashed"
      class="my-4"
    />
  </div>
</template>
