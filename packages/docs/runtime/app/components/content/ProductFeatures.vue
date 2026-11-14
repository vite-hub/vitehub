<script setup lang="ts">
// `::product-features` is the feature list of a product landing page. Its default slot holds
// `:::product-feature-item` entries: one claim, one sentence, one link. No code: the hero carries the code.
defineProps<{
  /** Optional heading above the list. */
  title?: string
}>()
</script>

<template>
  <section class="not-prose py-10">
    <h2 v-if="title" class="mb-6 text-xl font-semibold text-highlighted">{{ title }}</h2>
    <UPageGrid>
      <slot />
    </UPageGrid>
  </section>
</template>
