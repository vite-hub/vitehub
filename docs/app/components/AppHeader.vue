<script setup lang="ts">
const route = useRoute();
const isDocsRoute = computed(() => route.path.startsWith("/docs"));
const isSupportMatrix = computed(
  () => route.path.replace(/\/+$/, "") === "/docs/frameworks-hosts/support-matrix",
);

const navLinks = [
  { label: "Agents", to: "/docs/agents" },
  { label: "Primitives", to: "/docs/server-primitives" },
  { label: "Docs", to: "/docs" },
  { label: "Examples", to: "/examples" },
  { label: "Blog", to: "/blog" },
];

const mobileLinks = [
  { label: "Home", to: "/" },
  ...navLinks,
];
</script>

<template>
  <div class="sticky top-0 z-50">
    <UHeader :ui="{ toggle: isSupportMatrix ? 'hidden' : undefined }">
      <template #left>
        <UTooltip
          text="Just a library where I test different solutions and agents. APIs break all the time."
          :content="{ side: 'bottom', sideOffset: 8 }"
          :ui="{ content: 'h-auto max-w-64 whitespace-normal px-3 py-2 text-left leading-5' }"
        >
          <ULink to="/" class="vh-brand" aria-label="ViteHub alpha">
            <span class="vh-brand-mark" aria-hidden="true">
              <img src="/vitehub-mark.svg" alt="" class="h-4 w-[1.125rem]" />
            </span>
            <span class="vh-brand-name">
              <span>ViteHub</span>
              <span class="vh-brand-alpha">alpha</span>
            </span>
          </ULink>
        </UTooltip>
      </template>

      <nav class="flex items-center gap-1" aria-label="Primary">
        <UButton
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          :label="link.label"
          color="neutral"
          variant="ghost"
          size="sm"
        />
      </nav>

      <template #right>
        <UContentSearchButton
          collapsed
          :kbds="[]"
          :ui="{
            base: '!w-8 shrink-0 justify-center rounded-md border-0 !p-1.5 text-default hover:bg-elevated',
            label: 'sr-only',
            trailing: 'hidden',
          }"
        />
        <ClientOnly>
          <UColorModeButton />
          <template #fallback>
            <div class="size-8 animate-pulse bg-muted" />
          </template>
        </ClientOnly>
        <UButton
          to="https://github.com/vite-hub/vitehub"
          target="_blank"
          icon="i-simple-icons-github"
          variant="ghost"
          color="neutral"
          aria-label="ViteHub on GitHub"
        />
      </template>

      <template #body>
        <div v-if="isDocsRoute && !isSupportMatrix" class="-mx-4 -my-2">
          <DocsAsideLeftTop />
          <DocsAsideLeftBody />
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
