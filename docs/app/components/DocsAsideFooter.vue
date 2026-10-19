<script setup lang="ts">
// Docs pages have no site header, so the panel keeps the community links and the color mode control at its foot.
const { github, socials } = useAppConfig();
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
      aria-label="ViteHub on GitHub"
    />
    <UButton
      :to="socials.discord"
      target="_blank"
      icon="i-ph-discord-logo-light"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="ViteHub on Discord"
    />
    <ClientOnly>
      <UColorModeButton color="neutral" variant="ghost" size="sm" class="ms-auto" />
      <template #fallback>
        <div class="ms-auto size-7" />
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
