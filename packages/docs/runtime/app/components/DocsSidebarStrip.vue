<script setup lang="ts">
import { docsHomePath } from "#docs/navigation"

// A collapsed sidebar of a site without the rail: the brand, a button that opens the sidebar, search, and the site
// links, in one narrow column. The open sidebar has its collapse button in the same place.
const { site, start } = useDocsConfig()
const docsHome = docsHomePath(useDocsManifest(), start)
const brandLabel = site.badge ? `${site.name} ${site.badge.label}` : site.name
const { toggle, focusMounted } = useDocsSidebarToggle()
onMounted(focusMounted)
</script>

<template>
  <nav class="vh-docs-strip" :aria-label="`${site.name} navigation`">
    <UTooltip :text="brandLabel" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150">
      <NuxtLink :to="docsHome ?? '/'" class="vh-docs-strip-brand" data-focus-inset :aria-label="brandLabel">
        <DocsBrandMark v-if="site.logo" />
        <span v-else class="vh-docs-strip-initial">{{ site.name.charAt(0) }}</span>
      </NuxtLink>
    </UTooltip>
    <UTooltip text="Show navigation" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" ignore-non-keyboard-focus>
      <button :id="docsSidebarToggleIds.show" type="button" class="vh-docs-strip-button" data-focus-inset aria-label="Show navigation" @click="toggle(true)">
        <UIcon name="i-lucide-panel-left-open" class="size-4" />
      </button>
    </UTooltip>
    <UContentSearchButton
      collapsed
      label="Search docs"
      :tooltip="{ content: { side: 'right', sideOffset: 6 }, delayDuration: 150 }"
      class="vh-docs-strip-button"
      data-focus-inset
      :ui="{ base: 'h-10 w-full justify-center rounded-none border-0 border-b border-default bg-transparent text-dimmed hover:bg-elevated/50 hover:text-highlighted' }"
    />
    <DocsAsideFooter stacked class="mt-auto" />
  </nav>
</template>

<style scoped>
.vh-docs-strip {
  display: flex;
  width: var(--vh-rail-width);
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
}

/* 56px, the height of the brand row of the open sidebar, so the brand stays put when the sidebar opens. */
.vh-docs-strip-brand {
  --vh-docs-mark-size: 1.25rem;
  display: flex;
  flex: none;
  height: 3.5rem;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-highlighted);
}

.vh-docs-strip-initial {
  font-weight: 650;
}

.vh-docs-strip-button {
  display: flex;
  height: 2.5rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-dimmed);
  transition: color 150ms ease, background-color 150ms ease;
}

@media (hover: hover) {
  .vh-docs-strip-button:hover {
    background: color-mix(in oklab, var(--ui-bg-elevated) 50%, transparent);
    color: var(--ui-text-highlighted);
  }
}

</style>
