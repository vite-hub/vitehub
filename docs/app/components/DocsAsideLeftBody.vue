<script setup lang="ts">
const route = useRoute();
const { sidebarNavigation } = useSubNavigation();

const contentNavVariants = useUIConfig("contentNavigation");
const isBetterAuthFixture = computed(() => route.path.includes("/docs/getting-started/better-auth-style"));

const betterAuthNavigation = [
  {
    label: "Get Started",
    icon: "i-lucide-circle-play",
    open: true,
    children: [
      { label: "Introduction", icon: "i-lucide-book-open" },
      { label: "Comparison", icon: "i-lucide-copy" },
      { label: "Installation", icon: "i-lucide-square-terminal", active: true },
      { label: "Basic Usage", icon: "i-lucide-panel-top" },
    ],
  },
  { label: "Concepts", icon: "i-lucide-book-open" },
  { label: "Authentication", icon: "i-lucide-id-card" },
  { label: "Databases", icon: "i-lucide-database" },
  { label: "Integrations", icon: "i-lucide-layout-grid" },
  { label: "Infrastructure", icon: "i-lucide-server" },
  { label: "Plugins", icon: "i-lucide-plug" },
  { label: "Guides", icon: "i-lucide-panels-top-left" },
  { label: "AI Resources", icon: "i-lucide-sparkles" },
  { label: "Reference", icon: "i-lucide-library" },
];
</script>

<template>
  <nav v-if="isBetterAuthFixture" class="better-auth-sidebar-nav">
    <div
      v-for="item in betterAuthNavigation"
      :key="item.label"
      class="better-auth-sidebar-group"
    >
      <button type="button" class="better-auth-sidebar-group-button">
        <UIcon :name="item.icon" class="size-4 shrink-0" />
        <span>{{ item.label }}</span>
        <UIcon
          v-if="item.open"
          name="i-lucide-chevron-up"
          class="ml-auto size-3.5 text-muted"
        />
        <UIcon
          v-else
          name="i-lucide-chevron-down"
          class="ml-auto size-3.5 text-muted"
        />
      </button>

      <div v-if="item.children?.length" class="better-auth-sidebar-children">
        <NuxtLink
          v-for="child in item.children"
          :key="child.label"
          to="/docs/getting-started/better-auth-style/"
          :class="['better-auth-sidebar-child', { 'is-active': child.active }]"
        >
          <UIcon :name="child.icon" class="size-3.5 shrink-0" />
          <span>{{ child.label }}</span>
        </NuxtLink>
      </div>
    </div>
  </nav>

  <UContentNavigation
    v-else
    :highlight="contentNavVariants.highlight ?? true"
    :highlight-color="contentNavVariants.highlightColor"
    :variant="contentNavVariants.variant ?? 'link'"
    :color="contentNavVariants.color"
    :navigation="sidebarNavigation"
  />
</template>
