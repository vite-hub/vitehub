<script setup lang="ts">
import { docsHomePath } from "#docs/navigation"

const route = useRoute()
const { base, github, site, start } = useDocsConfig()
const docsHome = docsHomePath(useDocsManifest())
// Docs routes and the start links use the docs shell. There the brand opens the docs home, like a docs site logo,
// and the menu shows the docs sidebar. Elsewhere the brand opens the home page.
// On wide screens the docs sidebar carries the brand, the links, and the controls, so the header hides.
// The error page has no docs sidebar, so it keeps the header and its way home.
const shell = useDocsShell()
const error = useError()
const isDocsRoute = computed(() => shell.value && !error.value)
const menuOpen = ref(false)

// A site without docs pages has no "Docs" link.
const navLinks = [
  ...docsHome ? [{ label: "Docs", to: docsHome }] : [],
  ...(start?.links ?? []).filter(link => link.to !== base).map(link => ({ label: link.label, to: link.to })),
]

const mobileLinks = [
  { label: "Home", to: "/" },
  ...navLinks,
]

// The docs drawer already lists the docs pages.
const docsMobileLinks = mobileLinks.filter(link => link.to !== base && !link.to.startsWith(`${base}/`))

function isActiveLink(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`)
}

// Touch screens get 44px header icon buttons. Below 360px they are 40px wide, so the brand and four buttons fit a 320px row.
const touchIconButton = "pointer-coarse:size-11 max-[22.5rem]:pointer-coarse:w-10 pointer-coarse:justify-center"
</script>

<template>
  <div class="sticky top-0 z-50" :class="{ 'lg:hidden': isDocsRoute }">
    <UHeader
      v-model:open="menuOpen"
      :ui="{
        // Docs pages pin the rail to the left edge, so the header spans the full width.
        container: isDocsRoute ? 'max-w-none' : undefined,
        left: 'gap-6',
        right: 'pointer-coarse:gap-0.5',
        toggle: touchIconButton,
      }"
    >
      <template #left>
        <!-- The menu repeats this slot and focuses the brand first. Its tooltip would take the first Escape, so it is off there. -->
        <UTooltip
          :text="site.badge?.tooltip ?? undefined"
          :disabled="!site.badge?.tooltip || menuOpen"
          :content="{ side: 'bottom', sideOffset: 8 }"
          ignore-non-keyboard-focus
          :ui="{ content: 'h-auto max-w-64 whitespace-normal px-3 py-2 text-left leading-5' }"
        >
          <ULink :to="isDocsRoute && docsHome ? docsHome : '/'" class="vh-brand" :aria-label="site.badge ? `${site.name} ${site.badge.label}` : site.name">
            <span v-if="site.logo" class="vh-brand-mark" :style="{ '--vh-docs-logo': `url(${site.logo})` }" aria-hidden="true" />
            <span class="vh-brand-name">
              <span>{{ site.name }}</span>
              <span v-if="site.badge" class="vh-brand-alpha">{{ site.badge.label }}</span>
            </span>
          </ULink>
        </UTooltip>

        <nav v-if="!isDocsRoute" class="hidden items-center gap-1 lg:flex" aria-label="Primary">
          <UButton
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            :label="link.label"
            :active="isActiveLink(link.to)"
            color="neutral"
            variant="ghost"
            active-variant="soft"
            size="sm"
          />
        </nav>
      </template>

      <template #right>
        <UContentSearchButton
          :collapsed="false"
          :kbds="['meta', 'K']"
          :ui="{
            base: 'hidden h-8 !w-56 rounded-md border-0 bg-elevated/60 px-2.5 text-sm text-muted hover:bg-elevated hover:text-highlighted lg:inline-flex',
            trailing: 'ms-auto flex items-center gap-0.5',
          }"
        />
        <UContentSearchButton
          collapsed
          :kbds="[]"
          :ui="{
            base: '!w-8 shrink-0 justify-center rounded-md border-0 !p-1.5 text-default hover:bg-elevated pointer-coarse:!size-11 max-[22.5rem]:pointer-coarse:!w-10 lg:hidden',
            label: 'sr-only',
            trailing: 'hidden',
          }"
        />
        <UButton
          v-if="github"
          :to="github.url"
          target="_blank"
          icon="i-simple-icons-github"
          variant="ghost"
          color="neutral"
          :aria-label="`${site.name} on GitHub`"
          :class="touchIconButton"
        />
        <ClientOnly>
          <UColorModeButton :class="touchIconButton" />
          <!-- Before hydration, show the icon for the current mode. The color mode script sets the dark class before the first paint. -->
          <template #fallback>
            <span :class="['inline-flex size-8 items-center justify-center text-default', touchIconButton]" aria-hidden="true">
              <UIcon name="i-ph-sun-light" class="size-5 dark:hidden" />
              <UIcon name="i-ph-moon-light" class="hidden size-5 dark:block" />
            </span>
          </template>
        </ClientOnly>
      </template>

      <template #body>
        <div v-if="isDocsRoute" class="vh-docs-menu -mx-4 -my-2">
          <nav class="flex shrink-0 items-center gap-1 border-b border-default px-2 py-1.5" aria-label="Site">
            <UButton
              v-for="link in docsMobileLinks"
              :key="link.to"
              :to="link.to"
              :label="link.label"
              color="neutral"
              variant="ghost"
              size="sm"
              class="pointer-coarse:h-11"
            />
          </nav>
          <DocsSidebars class="vh-docs-menu-sidebars" panel labeled />
        </div>
        <nav v-else-if="!isDocsRoute" class="grid gap-1">
          <UButton
            v-for="link in mobileLinks"
            :key="link.to"
            :to="link.to"
            :label="link.label"
            color="neutral"
            variant="ghost"
            block
            class="justify-start"
          />
        </nav>
      </template>
    </UHeader>
  </div>
</template>

<style scoped>
/*
 * In the mobile menu the rail and the page panel sit side by side, as on wide screens.
 * The menu fills the visible body of the fullscreen menu (its padding minus this block's negative margin),
 * so the rail and the panel each scroll inside a bounded height.
 */
.vh-docs-menu {
  display: flex;
  height: calc(100dvh - var(--ui-header-height) - 1rem);
  flex-direction: column;
}

.vh-docs-menu-sidebars {
  min-height: 0;
  flex: 1 1 0;
}

@media (min-width: 40rem) {
  .vh-docs-menu {
    height: calc(100dvh - var(--ui-header-height) - 2rem);
  }
}

/* The header already shows the brand above the menu. */
.vh-docs-menu-sidebars :deep(.vh-docs-rail-brand),
.vh-docs-menu-sidebars :deep(.vh-docs-panel-brand) {
  display: none;
}

.vh-docs-menu-sidebars :deep(.vh-docs-panel) {
  flex: 1 1 auto;
  width: auto;
  border-right: 0;
}

.vh-brand {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 650;
  letter-spacing: 0;
}

/* On touch screens the brand text is about 20px tall. An invisible area makes the tap target 44px without moving the header. */
@media (pointer: coarse) {
  .vh-brand {
    position: relative;
  }

  .vh-brand::after {
    position: absolute;
    inset: -0.75rem -0.25rem;
    content: "";
  }
}

/* Like the docs rail, the mark is a mask filled with the text color, so it follows light and dark mode without a frame. */
.vh-brand-mark {
  display: block;
  width: 1.125rem;
  height: 1rem;
  background-color: var(--ui-text-highlighted);
  mask: var(--vh-docs-logo) center / contain no-repeat;
}

.vh-brand-name {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
}

.vh-brand-alpha {
  border-bottom: 1px dotted currentcolor;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1;
  transition: color 150ms ease;
}

.vh-brand:hover .vh-brand-alpha {
  color: var(--ui-text-highlighted);
}
</style>
