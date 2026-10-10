<script setup lang="ts">
// `::product-features` is the feature list of a product landing page. Its default slot holds
// `:::product-feature-item` entries: one claim, one sentence, one link. No code: the hero carries the code.
defineProps<{
  /** Optional heading above the list. */
  title?: string;
}>();
</script>

<template>
  <section class="not-prose vh-features">
    <h2 v-if="title" class="vh-features-title">{{ title }}</h2>
    <div class="vh-features-list">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.vh-features {
  padding-block: 2.5rem;
}

.vh-features-title {
  margin: 0 0 1.5rem;
  color: var(--ui-text-highlighted);
  font-size: 1.25rem;
  font-weight: 600;
}

.vh-features-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2rem 3rem;
}

@media (min-width: 48rem) {
  .vh-features-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
