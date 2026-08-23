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
    <UHeader :to="'/'" title="ViteHub" :ui="{ toggle: isSupportMatrix ? 'hidden' : undefined }">
      <template #title>
        <span class="vh-brand" aria-label="ViteHub">
          <span class="vh-brand-mark" aria-hidden="true">
            <img src="/vitehub-mark.svg" alt="" class="h-4 w-[1.125rem]" />
          </span>
          <span>ViteHub</span>
        </span>
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
  align-items: center;
  gap: 0.5rem;
  color: var(--ui-text-highlighted);
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
</style>
