<script setup lang="ts">
// Docs pages have no site header, so the panel keeps the community links and the color mode control at its foot.
const { github, site, socials } = useDocsConfig()
</script>

<template>
  <div class="vh-docs-aside-footer">
    <UButton
      v-if="github"
      :to="github.url"
      target="_blank"
      icon="i-ph-github-logo-light"
      color="neutral"
      variant="ghost"
      size="sm"
      class="pointer-coarse:size-10 pointer-coarse:justify-center"
      :aria-label="`${site.name} on GitHub`"
    />
    <UButton
      v-for="link in socials"
      :key="link.to"
      :to="link.to"
      target="_blank"
      :icon="link.icon"
      color="neutral"
      variant="ghost"
      size="sm"
      class="pointer-coarse:size-10 pointer-coarse:justify-center"
      :aria-label="link.label"
    />
    <ClientOnly>
      <UColorModeButton color="neutral" variant="ghost" size="sm" class="ms-auto pointer-coarse:size-10 pointer-coarse:justify-center" />
      <template #fallback>
        <div class="ms-auto size-7 pointer-coarse:size-10" />
      </template>
    </ClientOnly>
  </div>
</template>

<style scoped>
.vh-docs-aside-footer {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.25rem;
  border-top: 1px solid var(--ui-border);
  padding: 0.375rem 0.75rem;
}
</style>
