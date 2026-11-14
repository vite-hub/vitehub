<script setup lang="ts">
// A linked feature in the product landing list.
defineProps<{
  title: string
  /** Icon shown above the title. */
  icon?: string
  /** Docs page that explains the feature in full. */
  to: string
}>()
</script>

<template>
  <UPageCard :to="to" :icon="icon">
    <!-- Each feature is a heading of the landing page, so readers can jump between them. -->
    <template #title>
      <h2>{{ title }}</h2>
    </template>
    <template #description>
      <div class="vh-feature-description">
        <slot />
      </div>
    </template>
  </UPageCard>
</template>

<style scoped>
/* The sentence is Markdown, so its paragraph and inline code take the size of the card description. */
.vh-feature-description :deep(p) {
  margin: 0;
  font-size: inherit;
  line-height: inherit;
}

.vh-feature-description :deep(code) {
  display: inline;
  border: 0;
  border-radius: 0;
  background: none;
  padding: 0;
  color: var(--ui-text-toned);
  font-size: inherit;
}
</style>
