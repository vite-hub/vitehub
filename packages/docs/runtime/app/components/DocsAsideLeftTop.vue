<script setup lang="ts">
defineProps<{
  /** Shows the brand above search, for a sidebar without the rail that usually carries it. */
  brand?: boolean
}>()

const { site } = useDocsConfig()
</script>

<!-- The panel head holds only search. The rail marks the current product, and the page list starts with its Overview. -->
<template>
  <div class="vh-sidebar-head">
    <!-- Like the rail brand, it opens the home page. 40px including the border, so its rule lines up with the banner's. -->
    <NuxtLink v-if="brand" to="/" class="vh-docs-panel-brand" :aria-label="site.badge ? `${site.name} ${site.badge.label}` : site.name">
      <span v-if="site.logo" class="vh-docs-panel-brand-mark" :style="{ '--vh-docs-logo': `url(${site.logo})` }" aria-hidden="true" />
      <span>{{ site.name }}</span>
      <span v-if="site.badge" class="vh-docs-panel-brand-badge">{{ site.badge.label }}</span>
    </NuxtLink>
    <UContentSearchButton
      :collapsed="false"
      class="vh-sidebar-search"
      :ui="{
        base: 'h-10 rounded-none border-0 border-b border-default bg-muted/20 ps-5 pe-5 text-muted hover:bg-muted/40 hover:text-highlighted',
        // Touch screens have no keyboard shortcut to show.
        trailing: 'ms-auto flex items-center gap-1 pointer-coarse:hidden',
      }"
    />
  </div>
</template>

<style scoped>
.vh-sidebar-search {
  height: 2.5rem;
  font-size: 0.875rem;
}

.vh-docs-panel-brand {
  display: flex;
  height: 2.5rem;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--ui-border);
  padding-inline: 1.25rem;
  color: var(--ui-text-highlighted);
  font-size: 0.875rem;
  font-weight: 650;
}

.vh-docs-panel-brand:focus-visible {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}

.vh-docs-panel-brand-mark {
  display: block;
  width: 1.125rem;
  height: 1rem;
  background-color: var(--ui-text-highlighted);
  mask: var(--vh-docs-logo) center / contain no-repeat;
}

.vh-docs-panel-brand-badge {
  border-bottom: 1px dotted currentcolor;
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: 0.625rem;
  font-weight: 500;
}
</style>
