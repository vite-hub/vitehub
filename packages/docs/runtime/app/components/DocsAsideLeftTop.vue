<script setup lang="ts">
import { docsHomePath, docsSidebarGroup } from "#docs/navigation"

const props = defineProps<{
  /** Shows the brand, for a wide-screen sidebar without the rail that carries it. */
  brand?: boolean
  /** Shows search, for a wide-screen sidebar, which has no site header beside it. */
  search?: boolean
  /** Shows the name of what the panel lists, for a panel beside the rail. */
  title?: boolean
  /** Shows a button before search that collapses the sidebar, on a site without the rail, which holds it otherwise. */
  collapsible?: boolean
}>()

const { groups, site, start } = useDocsConfig()
const manifest = useDocsManifest()
const section = useDocsSection()
const docsHome = docsHomePath(manifest, start)
// The group of the current section, or the section itself.
const heading = computed(() => {
  if (!props.title || !section.value) return null
  return docsSidebarGroup(manifest, section.value, groups)?.title ?? section.value.title
})
const { toggle, focusMounted } = useDocsSidebarToggle()
onMounted(focusMounted)
</script>

<template>
  <!-- Like the header brand on other pages, it opens the docs home. 40px including the border, as the search row and the banner. -->
  <UTooltip
    v-if="brand"
    :text="site.badge?.tooltip ?? undefined"
    :disabled="!site.badge?.tooltip"
    :content="{ side: 'right', sideOffset: 8 }"
    ignore-non-keyboard-focus
    :ui="{ content: 'h-auto max-w-64 whitespace-normal px-3 py-2 text-left leading-5' }"
  >
    <NuxtLink :to="docsHome ?? '/'" class="vh-docs-panel-brand" data-focus-inset :aria-label="site.badge ? `${site.name} ${site.badge.label}` : site.name">
      <DocsBrandMark />
      <span>{{ site.name }}</span>
      <span v-if="site.badge" class="vh-docs-panel-brand-badge">{{ site.badge.label }}</span>
    </NuxtLink>
  </UTooltip>
  <!-- The collapse button sits where the collapsed strip has its open button, so the pointer can toggle in place. -->
  <div v-if="search" class="vh-docs-panel-search-row">
    <UTooltip v-if="collapsible" text="Hide navigation" :content="{ side: 'right', sideOffset: 6 }" :delay-duration="150" ignore-non-keyboard-focus>
      <button :id="docsSidebarToggleIds.hide" type="button" class="vh-docs-panel-collapse" data-focus-inset aria-label="Hide navigation" @click="toggle(false)">
        <UIcon name="i-lucide-panel-left-close" class="size-4" />
      </button>
    </UTooltip>
    <UContentSearchButton
      :collapsed="false"
      label="Search docs"
      :kbds="['meta', 'K']"
      class="vh-docs-panel-search"
      :ui="{
        base: 'h-10 w-full rounded-none border-0 bg-transparent px-4 text-muted hover:bg-elevated/50 hover:text-highlighted',
        // Touch screens have no keyboard shortcut to show.
        trailing: 'ms-auto flex items-center gap-0.5 pointer-coarse:hidden',
      }"
    />
  </div>
  <p v-if="heading" class="vh-docs-panel-title">{{ heading }}</p>
</template>

<style scoped>
.vh-docs-panel-brand {
  --vh-docs-mark-size: 1.25rem;
  display: flex;
  flex: none;
  height: 3.5rem;
  align-items: center;
  gap: 0.5rem;
  padding-inline: 1rem;
  color: var(--ui-text-highlighted);
  font-size: 0.9375rem;
  font-weight: 600;
}


.vh-docs-panel-brand-badge {
  border-bottom: 1px dotted currentcolor;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
}

.vh-docs-panel-search-row {
  display: flex;
  flex: none;
  border-bottom: 1px solid var(--ui-border);
}

.vh-docs-panel-search {
  min-width: 0;
  flex: 1 1 auto;
  font-size: 0.875rem;
}

.vh-docs-panel-brand + .vh-docs-panel-search-row {
  border-top: 1px solid var(--ui-border);
}

.vh-docs-panel-collapse {
  display: flex;
  width: var(--vh-rail-width);
  flex: none;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--ui-border);
  color: var(--ui-text-dimmed);
  transition: color 150ms ease, background-color 150ms ease;
}

@media (hover: hover) {
  .vh-docs-panel-collapse:hover {
    background: color-mix(in oklab, var(--ui-bg-elevated) 50%, transparent);
    color: var(--ui-text-highlighted);
  }
}

.vh-docs-panel-title {
  flex: none;
  margin: 0;
  padding: 1rem 1rem 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
}
</style>
