<script setup lang="ts">
const route = useRoute();
// On docs routes the brand opens the product catalog, like a docs site logo. Elsewhere it opens the home page.
const isDocsRoute = computed(() => route.path.startsWith("/docs"));

// Agents is one product in the docs rail and catalog, so the header links only to site areas.
const navLinks = [
  { label: "Docs", to: "/docs" },
  { label: "Examples", to: "/examples" },
  { label: "Guides", to: "/guides" },
];

const mobileLinks = [
  { label: "Home", to: "/" },
  ...navLinks,
];

// The docs drawer already lists the docs product pages.
const docsMobileLinks = mobileLinks.filter((link) => !link.to.startsWith("/docs"));

function isActiveLink(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`);
}

// Touch screens get taller header icon buttons. The 44px header and a 320px row still fit.
const touchIconButton = "pointer-coarse:h-10 pointer-coarse:w-9 pointer-coarse:justify-center";
</script>

<template>
  <div class="sticky top-0 z-50">
    <UHeader
      :ui="{
        // Docs pages pin the rail to the left edge, so the header spans the full width.
        container: isDocsRoute ? 'max-w-none' : undefined,
        left: 'gap-6',
        right: 'pointer-coarse:gap-0.5',
        toggle: touchIconButton,
      }"
    >
      <template #left>
        <UTooltip
          text="Just a library where I test different solutions and agents. APIs break all the time."
          :content="{ side: 'bottom', sideOffset: 8 }"
          ignore-non-keyboard-focus
          :ui="{ content: 'h-auto max-w-64 whitespace-normal px-3 py-2 text-left leading-5' }"
        >
          <ULink :to="isDocsRoute ? '/docs' : '/'" class="vh-brand" aria-label="ViteHub alpha">
            <span class="vh-brand-mark" aria-hidden="true">
              <img src="/vitehub-mark.svg" alt="" class="h-4 w-[1.125rem]" />
            </span>
            <span class="vh-brand-name">
              <span>ViteHub</span>
              <span class="vh-brand-alpha">alpha</span>
            </span>
          </ULink>
        </UTooltip>

        <nav class="hidden items-center gap-1 lg:flex" aria-label="Primary">
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
            base: '!w-8 shrink-0 justify-center rounded-md border-0 !p-1.5 text-default hover:bg-elevated pointer-coarse:!h-10 pointer-coarse:!w-9 lg:hidden',
            label: 'sr-only',
            trailing: 'hidden',
          }"
        />
        <UButton
          to="https://github.com/vite-hub/vitehub"
          target="_blank"
          icon="i-simple-icons-github"
          variant="ghost"
          color="neutral"
          aria-label="ViteHub on GitHub"
          :class="touchIconButton"
        />
        <ClientOnly>
          <UColorModeButton :class="touchIconButton" />
          <template #fallback>
            <div :class="['size-8 animate-pulse bg-muted', touchIconButton]" />
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
            />
          </nav>
          <DocsSidebars class="vh-docs-menu-sidebars" panel />
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

.vh-brand-mark {
  display: inline-grid;
  width: 1.5rem;
  height: 1.5rem;
  place-items: center;
  border: 1px solid var(--ui-border);
  background: #fafafa;
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
