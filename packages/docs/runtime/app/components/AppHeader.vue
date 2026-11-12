<script setup lang="ts">
import { useMediaQuery } from "@vueuse/core"
import { docsHomePath, isDocsPath, normalizeDocsPath } from "#docs/navigation"
import { useDocsHeaderActionsTarget } from "../composables/headerActions"

const route = useRoute()
const { base, github, site, socials, start } = useDocsConfig()
const docsHome = docsHomePath(useDocsManifest(), start)
// Docs routes and the start links use the docs shell. There the brand opens the docs home, like a docs site logo,
// and the menu shows the docs sidebar. Elsewhere the brand opens the home page.
// The header is the same on every page: the brand, search in the middle, and the site's links and controls.
const shell = useDocsShell()
const error = useError()
const isDocsRoute = computed(() => shell.value && !error.value)
const menuOpen = ref(false)
const wide = useMediaQuery("(min-width: 64rem)", { ssrWidth: 0 })
const actionsTargetId = useDocsHeaderActionsTarget()
const actionsTarget = computed(() => wide.value && actionsTargetId.value ? document.getElementById(actionsTargetId.value) : null)
// Nuxt turns a `null` in runtime config into "", so only a number counts.
const stars = github && typeof github.stars === "number" ? new Intl.NumberFormat("en", { notation: "compact" }).format(github.stars) : null

// A site without docs pages has no "Docs" link. A start link that "Docs" already opens would repeat it.
const navLinks = [
  ...docsHome ? [{ label: "Docs", to: docsHome }] : [],
  ...(start?.links ?? []).filter(link => link.to !== base && normalizeDocsPath(link.to) !== docsHome).map(link => ({ label: link.label, to: link.to })),
]

const mobileLinks = [
  { label: "Home", to: "/" },
  ...navLinks,
]

// The docs drawer already lists the docs pages.
const docsMobileLinks = mobileLinks.filter(link => !isDocsPath(link.to, base))

function isActiveLink(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`)
}

// Touch screens get 44px header icon buttons. Below 360px they are 40px wide, so the brand and four buttons fit a 320px row.
const touchIconButton = "pointer-coarse:size-11 max-[22.5rem]:pointer-coarse:w-10 pointer-coarse:justify-center"
</script>

<template>
  <div class="vh-docs-header sticky top-0 z-50">
    <UHeader
      v-model:open="menuOpen"
      :ui="withDocsTheme('header', {
        // Docs pages pin the rail to the left edge, so the header spans the full width.
        container: isDocsRoute ? 'max-w-none' : undefined,
        right: 'pointer-coarse:gap-0.5',
        toggle: touchIconButton,
      })"
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
            <DocsBrandMark class="vh-brand-mark" />
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
            variant="ghost"
            active-variant="soft"
          />
        </nav>
      </template>

      <UContentSearchButton
        :collapsed="false"
        label="Search docs"
        :kbds="['meta', 'K']"
        :ui="withDocsTheme('contentSearchButton', {
          base: 'vh-header-search hidden w-full lg:inline-flex',
          trailing: 'ms-auto flex items-center gap-0.5',
        })"
      />

      <template #right>
        <!-- Empty here: an app adds its own items with a `DocsHeaderActions` component, such as the package a page documents. -->
        <!-- Move one instance between shells so app state, IDs, and subscriptions stay unique. -->
        <Teleport :to="actionsTarget || '#teleports'" :disabled="!actionsTarget">
          <DocsHeaderActions />
        </Teleport>
        <UContentSearchButton
          collapsed
          :kbds="[]"
          :ui="withDocsTheme('contentSearchButton', {
            base: '!w-8 shrink-0 justify-center !p-1.5 text-default pointer-coarse:!size-11 max-[22.5rem]:pointer-coarse:!w-10 lg:hidden',
            label: 'sr-only',
            trailing: 'hidden',
          })"
        />
        <a
          v-if="github"
          :href="github.url"
          target="_blank"
          rel="noopener"
          class="vh-header-github"
          :aria-label="stars ? `${site.name} on GitHub, ${stars} stars` : `${site.name} on GitHub`"
        >
          <UIcon name="i-simple-icons-github" class="size-4 shrink-0" />
          <span class="vh-header-github-label">GitHub</span>
          <span v-if="stars" class="vh-header-github-stars">
            <UIcon name="i-lucide-star" class="size-3.5 shrink-0" />
            {{ stars }}
          </span>
        </a>
        <UButton
          v-for="link in socials"
          :key="link.to"
          :to="link.to"
          target="_blank"
          :icon="link.icon"
          :label="link.icon ? undefined : link.label"
          variant="ghost"
          :aria-label="link.label"
          :class="['hidden lg:inline-flex', link.icon ? touchIconButton : 'pointer-coarse:h-11']"
        />
        <!-- The button renders both icons and the color mode class picks one, so the server draws it too. -->
        <UColorModeButton :class="touchIconButton" />
      </template>

      <template #body>
        <div v-if="isDocsRoute" class="vh-docs-menu -mx-4 -my-2">
          <nav class="flex shrink-0 flex-wrap items-center gap-1 border-b border-default px-2 py-1.5" aria-label="Site">
            <UButton
              v-for="link in docsMobileLinks"
              :key="link.to"
              :to="link.to"
              :label="link.label"
              variant="ghost"
              class="pointer-coarse:h-11"
            />
            <UButton
              v-for="link in socials"
              :key="link.to"
              :to="link.to"
              :label="link.label"
              :icon="link.icon"
              target="_blank"
              variant="ghost"
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
            variant="ghost"
            block
            class="justify-start"
          />
          <UButton
            v-for="link in socials"
            :key="link.to"
            :to="link.to"
            :label="link.label"
            :icon="link.icon"
            target="_blank"
            variant="ghost"
            block
            class="justify-start pointer-coarse:h-11"
          />
        </nav>
      </template>
    </UHeader>
  </div>
</template>

<style scoped>
/* A replacement layout or sidebar keeps the header until it supplies the sidebar controls. */
@media (min-width: 64rem) {
  :global(body:has([data-docs-sidebar-head]) .vh-docs-header) {
    display: none;
  }
}

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
  --vh-docs-mark-size: 1.5rem;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0;
  white-space: nowrap;
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

/* The search button of the old comark-ui header: a soft field in the middle column, with its shortcut at the end. */
:deep(.vh-header-search) {
  height: 2.25rem;
  gap: 0.5rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  background: var(--ui-bg-muted);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  padding: 0 0.375rem 0 0.75rem;
  color: var(--ui-text-dimmed);
  font-size: 0.875rem;
  font-weight: 400;
  transition: box-shadow 150ms ease, color 150ms ease;
}

:deep(.vh-header-search kbd) {
  text-transform: none;
}

@media (hover: hover) {
  :deep(.vh-header-search:hover) {
    box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
    color: var(--ui-text-muted);
  }
}

/* A framed link with the star count after a hairline, as on the old comark-ui site, with the control radius of the design system. */
.vh-header-github {
  display: inline-flex;
  height: 2rem;
  flex: none;
  align-items: center;
  gap: 0.375rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  padding: 0 0.75rem;
  color: var(--ui-text-highlighted);
  font-size: 0.8125rem;
  font-weight: 500;
  transition: box-shadow 150ms ease;
}

.vh-header-github-stars {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: 0.125rem;
  border-left: 1px solid var(--ui-border);
  padding-left: 0.625rem;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

@media (hover: hover) {
  .vh-header-github:hover {
    box-shadow: inset 0 0 0 1px var(--ui-text-dimmed);
  }
}

/* Narrow screens keep the mark alone, a 44px target on touch. */
@media (width < 60rem) {
  .vh-header-github {
    width: 2.5rem;
    justify-content: center;
    box-shadow: none;
    padding: 0;
  }

  .vh-header-github-label,
  .vh-header-github-stars {
    display: none;
  }
}

@media (pointer: coarse) {
  .vh-header-github {
    height: 2.75rem;
  }
}

/* 44px wide on touch, like the other header buttons, and 40px below 360px so the row still fits a 320px screen. */
@media (width < 60rem) and (pointer: coarse) {
  .vh-header-github {
    width: 2.75rem;
  }
}

@media (width < 22.5rem) and (pointer: coarse) {
  .vh-header-github {
    width: 2.5rem;
  }
}
</style>
