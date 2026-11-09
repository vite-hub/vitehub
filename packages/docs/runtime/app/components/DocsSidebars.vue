<script setup lang="ts">
import { docsHasRail } from "#docs/navigation"

defineProps<{
  /** Shows the page panel next to the rail. Outside a section the panel lists every product. */
  panel: boolean
  /** Shows the rail labels, for the mobile menu where touch has no hover to expand the rail. */
  labeled?: boolean
  /** Shows the brand, search, and the links row, for wide screens, which have no site header beside the sidebar. */
  head?: boolean
  /**
   * On a page with a collapsible sidebar, shows the button that opens or collapses it. Collapsed, a site with the rail
   * shows the rail alone and a site without it shows a strip. `panel` is then false.
   */
  collapsible?: boolean
}>()

// A small site has no rail. The panel lists every section with its pages.
const config = useDocsConfig()
const rail = docsHasRail(useDocsManifest(), config.icons, config.groups, config)
</script>

<template>
  <div class="vh-docs-sidebars" :data-docs-sidebar-head="head && (panel || collapsible) ? '' : undefined">
    <DocsRail v-if="rail" :labeled="labeled" :brand="head" :toggle="collapsible ? (panel ? 'hide' : 'show') : undefined" />
    <DocsSidebarStrip v-else-if="collapsible && !panel" />
    <div v-if="panel" class="vh-docs-panel" :class="{ 'is-single': !rail, 'has-head': head }">
      <DocsAsideLeftTop :brand="head && !rail" :search="head" :title="rail" :collapsible="collapsible && !rail" />
      <DocsAsideLeftBody />
      <DocsAsideFooter v-if="head" />
    </div>
  </div>
</template>

<style scoped>
/* The parent sets the height. The rail and the panel each scroll inside it. Nothing here clips, so the expanded rail can cover the panel. */
.vh-docs-sidebars {
  display: flex;
  min-height: 0;
}

.vh-docs-panel {
  display: flex;
  width: var(--vh-panel-width);
  min-width: 0;
  min-height: 0;
  flex: 0 1 auto;
  flex-direction: column;
  overflow: hidden;
}

/* Without the rail, the panel takes the whole sidebar width. */
.vh-docs-panel.is-single {
  width: auto;
  flex: 1 1 auto;
  padding-top: 0.75rem;
}

/* The brand and search open the panel, so the page list needs no space above it. */
.vh-docs-panel.is-single.has-head {
  padding-top: 0;
}
</style>
