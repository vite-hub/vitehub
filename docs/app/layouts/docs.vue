<script setup lang="ts">
import { docsManifest, getDocsPageByPath, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { isDocsLandingPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";
import { isDocsSiteArea } from "~/composables/useDocsSection";

const route = useRoute();
// The catalog and every product Overview are landing pages: one wide column without a table of contents.
const isLanding = computed(() => isDocsLandingPath(docsManifest.sections, route.path));
// Tutorials, Projects, and Templates set their own container.
const isSiteArea = computed(() => isDocsSiteArea(route.path));
// A tutorial with a code panel uses the whole page column, half for prose and half for files.
const hasCodePanel = computed(() => getDocsPageByPath(normalizeDocsPath(route.path))?.codePanel === true);
const tutorialNavigation = useTutorialNavigation();
// Other docs pages always show the navigation. A tutorial shows it only when the reader opens it.
const showsNavigation = computed(() => !hasCodePanel.value || tutorialNavigation.value);

// The sidebar sits on the left edge of the viewport on every docs page. The page content centers in the remaining space.
const docsShellUi = {
  root: "lg:!flex lg:!flex-row lg:!items-start lg:!gap-0",
  left: "lg:!w-(--vh-sidebar-width) lg:shrink-0",
  center: "lg:!flex-1 lg:!min-w-0",
};
</script>

<template>
  <!-- There is no site footer. On wide screens there is no site header either: the sidebar carries the brand and the links. -->
  <UMain class="vh-docs-shell" :class="{ 'is-tutorial': hasCodePanel }">
    <!-- The sidebar holds about 30 links, so keyboard users can jump past it. The link shows only when it has focus. -->
    <a href="#docs-content" class="vh-skip-link">Skip to content</a>
    <UPage :ui="docsShellUi">
      <template v-if="showsNavigation" #left>
        <UPageAside class="vh-docs-aside hidden lg:flex">
          <DocsSidebars class="vh-docs-aside-sidebars" panel />
        </UPageAside>
      </template>

      <!-- The banner spans the page column, so its border meets the sidebar and the right edge. -->
      <div id="docs-content" tabindex="-1" class="relative">
        <!-- Narrow screens open the navigation from the header menu and keep the code inline, so the button shows only on wide screens. -->
        <UTooltip v-if="hasCodePanel" :text="tutorialNavigation ? 'Hide navigation' : 'Show navigation'" :content="{ side: 'bottom', sideOffset: 6 }" :delay-duration="150">
          <button
            type="button"
            class="vh-tutorial-toggle"
            :class="{ 'beside-navigation': showsNavigation }"
            :aria-label="tutorialNavigation ? 'Hide navigation' : 'Show navigation'"
            :aria-pressed="tutorialNavigation"
            @click="tutorialNavigation = !tutorialNavigation"
          >
            <UIcon name="i-lucide-panel-left" class="size-4" />
          </button>
        </UTooltip>
        <AnnouncementBanner />
      </div>
      <slot v-if="isSiteArea" />
      <div v-else :class="isLanding ? 'vh-docs-landing' : hasCodePanel ? 'vh-docs-split' : 'vh-docs-main'">
        <slot />
      </div>
    </UPage>
  </UMain>
</template>

<style scoped>
.vh-skip-link {
  position: fixed;
  top: 0.5rem;
  left: 0.5rem;
  z-index: 60;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  transform: translateY(calc(-100% - 1rem));
}

.vh-skip-link:focus {
  transform: none;
}

.vh-docs-main,
.vh-docs-landing,
.vh-docs-split {
  margin: 0 auto;
  padding: 0 1rem;
}


.vh-docs-main {
  max-width: calc(var(--vh-content-width) + var(--vh-toc-width) + 4rem);
}

.vh-docs-landing {
  max-width: 84rem;
}

@media (min-width: 40rem) {
  .vh-docs-main,
  .vh-docs-landing,
  .vh-docs-split {
    padding: 0 2rem;
  }
}

/* The code panel reaches the right edge of the page. */
@media (min-width: 80rem) {
  .vh-docs-split {
    padding-right: 0;
  }
}

.vh-tutorial-toggle {
  display: none;
}

@media (min-width: 64rem) {
  /* The button stays in the top left corner of the page column while the tutorial scrolls. At the top it is the first cell of the banner row. */
  .vh-tutorial-toggle {
    position: fixed;
    z-index: 10;
    top: 0;
    left: 0;
    display: flex;
    width: 2.5rem;
    height: 2.5rem;
    align-items: center;
    justify-content: center;
    border-right: 1px solid var(--ui-border);
    border-bottom: 1px solid var(--ui-border);
    background: var(--ui-bg);
    color: var(--ui-text-dimmed);
    transition: color 150ms ease, background-color 150ms ease;
  }

  .vh-tutorial-toggle.beside-navigation {
    left: var(--vh-sidebar-width);
  }

  .vh-tutorial-toggle[aria-pressed="true"] {
    background: var(--ui-bg-elevated);
    color: var(--ui-text-highlighted);
  }

  .vh-tutorial-toggle:hover {
    color: var(--ui-text-highlighted);
  }

  .vh-tutorial-toggle:focus-visible {
    outline: 2px solid var(--ui-primary);
    outline-offset: -2px;
  }

  /* With the article padding, the prose starts just clear of the pinned button. */
  .vh-docs-split {
    padding-left: 1.25rem;
  }

  /* Beside a tutorial the navigation is a short page list, so its panel is narrower and the prose and code keep the width. */
  /* The sum is set again here, because a custom property resolves its calc() where it is declared. */
  .vh-docs-shell.is-tutorial {
    --vh-panel-width: 12rem;
    --vh-sidebar-width: calc(var(--vh-rail-width) + var(--vh-panel-width));
  }

  /* AppHeader hides itself on wide docs pages. Sticky offsets and full-height columns read this variable. */
  .vh-docs-shell {
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

  /* A denser rail on desktop, so every product fits without scrolling on common laptop heights. The mobile menu keeps touch-size items. */
  .vh-docs-aside-sidebars :deep(.vh-primitive-rail) {
    --vh-primitive-rail-item: 2rem;
  }

  .vh-docs-aside-sidebars :deep(.vh-primitive-rail__surface) {
    padding-block: 0.25rem;
  }

  .vh-docs-aside-sidebars :deep(.vh-primitive-rail__group) {
    gap: 0;
    padding-block: 0.1875rem;
  }

  /* The aside draws the right border. */
  .vh-docs-aside-sidebars :deep(.vh-docs-panel) {
    border-right: 0;
  }
}

</style>
