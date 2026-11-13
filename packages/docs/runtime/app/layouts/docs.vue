<script setup lang="ts">
const { banner } = useDocsConfig()
const found = useDocsPage()
// A tutorial with a code panel uses the whole page column, half for prose and half for files.
const hasCodePanel = computed(() => found.value?.page.codePanel === true)
// Pages show the sidebar unless they set `sidebar: false`. A page with `sidebar: "collapsed"`, and a code panel tutorial,
// shows a narrow strip until the reader opens the sidebar.
const sidebar = useDocsSidebar()

// The sidebar sits on the left edge of the viewport on every docs page. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
}
</script>

<template>
  <DocsAppShell layout>
    <!-- On wide screens the sidebar carries the brand, search, and the site links, so the site header hides beside it. -->
    <UMain class="vh-docs-shell" :class="{ 'is-tutorial': hasCodePanel, 'has-sidebar': sidebar.state !== 'hidden', 'is-collapsed': sidebar.state === 'collapsed' }">
      <!-- The sidebar holds about 30 links, so keyboard users can jump past it. The link shows only when it has focus. -->
      <a href="#docs-content" class="vh-skip-link">Skip to content</a>
      <UPage :ui="withDocsTheme('page', docsShellUi)">
        <template v-if="sidebar.state !== 'hidden'" #left>
          <UPageAside class="vh-docs-aside hidden lg:flex">
            <!-- Phones hide this column and open the sidebar from the header menu, so it hydrates only once it shows. -->
            <LazyDocsSidebars hydrate-on-visible class="vh-docs-aside-sidebars" :panel="sidebar.state === 'open'" head :collapsible="sidebar.collapsible" />
          </UPageAside>
        </template>

        <!-- The banner spans the page column, so its border meets the sidebar and the right edge. -->
        <div id="docs-content" tabindex="-1" class="relative">
          <!-- 40px including the border, the same height as the sidebar search, so both bottom rules line up. It grows when the text wraps. -->
          <!-- A page with a collapsible sidebar, such as a playground, fills the viewport, so it has no banner. -->
          <div v-if="banner && !sidebar.collapsible" class="flex min-h-10 items-center justify-center border-b border-default bg-default px-4 py-2 text-center text-sm/5">
            <span class="text-muted">{{ banner }}</span>
          </div>
        </div>
        <slot />
      </UPage>
    </UMain>
  </DocsAppShell>
</template>

<style scoped>
.vh-skip-link {
  position: fixed;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 60;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  transform: translateY(calc(-100% - 1rem));
}

.vh-skip-link:focus {
  transform: none;
}

@media (min-width: 64rem) {
  /* Beside a tutorial the navigation is a short page list, so its panel is narrower and the prose and code keep the width. */
  /* The sum is set again here, because a custom property resolves its calc() where it is declared. */
  .vh-docs-shell.is-tutorial {
    --vh-panel-width: 12rem;
    --vh-sidebar-width: calc(var(--vh-rail-width) + var(--vh-panel-width));
  }

  /* A collapsed sidebar is a strip as wide as the rail. */
  .vh-docs-shell.is-collapsed {
    --vh-sidebar-width: var(--vh-rail-width);
  }

  /* AppHeader hides beside the sidebar. Sticky offsets and full-height columns read this variable. */
  .vh-docs-shell.has-sidebar:has([data-docs-sidebar-head]) {
    --ui-header-height: 0px;
  }

  .vh-docs-aside {
    position: sticky;
    top: var(--ui-header-height);
    display: flex;
    height: calc(100dvh - var(--ui-header-height));
    max-height: calc(100dvh - var(--ui-header-height));
    min-height: calc(100dvh - var(--ui-header-height));
    flex-direction: column;
    overflow: hidden;
    border-right: 1px solid var(--ui-border);
  }

  /* The aside container is a flex column. Without a flex basis the sidebars shrink to the rail header and the panel loses its page list. */
  .vh-docs-aside-sidebars {
    min-height: 0;
    flex: 1 1 0;
  }

}

</style>
