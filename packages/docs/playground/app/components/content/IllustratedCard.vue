<script setup lang="ts">
// One card of `::illustrated-cards`: an illustration, a title that links, and the slot as its description.
defineProps<{ title: string, to: string, illustration: string, alt: string }>()
</script>

<template>
  <NuxtLink :to="to" class="group flex flex-col border-b border-r border-default p-5 transition-colors hover:bg-elevated/50 focus-visible:bg-elevated/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-primary)">
    <LumenIllustration :name="illustration" :alt="alt" class="mx-auto w-full max-w-72" />
    <span class="mt-4 flex items-center gap-1.5 text-sm font-semibold text-highlighted">
      {{ title }}
      <UIcon name="i-lucide-arrow-right" class="size-3.5 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </span>
    <div class="mt-1.5 text-sm leading-6 text-muted text-pretty [&_p]:m-0"><slot /></div>
  </NuxtLink>
</template>
