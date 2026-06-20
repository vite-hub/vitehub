<script setup lang="ts">
const route = useRoute();
const isBetterAuthFixture = computed(() => route.path.includes("/docs/getting-started/better-auth-style"));

const betterAuthLinks = [
  { label: "README", to: "#" },
  { label: "DOCS", to: "#", active: true },
  { label: "PRODUCTS", to: "#", trailingIcon: "i-lucide-chevron-down" },
  { label: "ENTERPRISE", to: "#" },
  { label: "RESOURCES", to: "#", trailingIcon: "i-lucide-chevron-down" },
];

const primaryLinks = [
  { label: "Docs", to: "/docs" },
  { label: "Agents", to: "/docs/agents" },
  { label: "Capabilities", to: "/docs/capabilities" },
  { label: "Primitives", to: "/docs/server-primitives" },
  { label: "Blog", to: "/blog" },
];
const mobileLinks = [
  { label: "Home", to: "/" },
  ...primaryLinks,
];

function isActiveLink(link: typeof mobileLinks[number]) {
  const { to } = link;
  if (to === "/") return route.path === "/";
  return route.path === to || route.path.startsWith(`${to}/`);
}
</script>

<template>
  <header v-if="isBetterAuthFixture" class="better-auth-topbar sticky top-0 z-50">
    <NuxtLink to="/docs/getting-started/better-auth-style/" class="better-auth-brand">
      <span class="better-auth-mark" aria-hidden="true" />
      <span>BETTER-AUTH.</span>
    </NuxtLink>

    <nav class="better-auth-main-nav">
      <NuxtLink
        v-for="link in betterAuthLinks"
        :key="link.label"
        :to="link.to"
        :class="['better-auth-main-nav-link', { 'is-active': link.active }]"
      >
        <span>{{ link.label }}</span>
        <UIcon v-if="link.trailingIcon" :name="link.trailingIcon" class="size-3" />
      </NuxtLink>
    </nav>

    <NuxtLink to="#" class="better-auth-sign-in">
      <span>SIGN-IN</span>
      <UIcon name="i-lucide-arrow-up-right" class="size-3" />
    </NuxtLink>

    <div class="better-auth-mobile-actions">
      <UContentSearchButton collapsed :kbds="[]" class="better-auth-mobile-search" />
      <ClientOnly>
        <UColorModeButton class="better-auth-mobile-icon" />
        <template #fallback>
          <div class="size-8 animate-pulse bg-muted" />
        </template>
      </ClientOnly>
      <UButton
        icon="i-lucide-menu"
        variant="ghost"
        color="neutral"
        aria-label="Menu"
        class="better-auth-mobile-icon"
      />
    </div>
  </header>

  <div class="sticky top-0 z-50">
    <UHeader v-if="!isBetterAuthFixture" :to="'/'" title="ViteHub">
      <template #title>
        <UColorModeImage
          light="/vitehub-logo-header.png"
          dark="/vitehub-logo-header-dark.png"
          alt="ViteHub"
          class="h-6 w-auto shrink-0 self-baseline"
        />
      </template>

      <nav class="hidden h-full items-center lg:flex">
        <UButton
          v-for="link in primaryLinks"
          :key="link.to"
          :to="link.to"
          :label="link.label"
          color="neutral"
          variant="ghost"
          size="sm"
          :class="[
            'h-full rounded-none border-x border-transparent px-4 xl:px-8 text-[11px] font-medium uppercase tracking-[0.18em]',
            isActiveLink(link) ? 'border-default border-b-highlighted text-highlighted' : 'text-muted hover:text-highlighted',
          ]"
        />
      </nav>

      <template #right>
        <UContentSearchButton collapsed :kbds="[]" class="lg:hidden" />
        <ClientOnly>
          <UColorModeButton />
          <template #fallback>
            <div class="size-8 animate-pulse rounded-md bg-muted" />
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
        <nav class="grid gap-1">
          <UButton
            v-for="link in mobileLinks"
            :key="link.to"
            :to="link.to"
            :label="link.label"
            :color="isActiveLink(link) ? 'primary' : 'neutral'"
            variant="ghost"
            block
            class="justify-start"
          />
        </nav>
      </template>
    </UHeader>
  </div>
</template>
