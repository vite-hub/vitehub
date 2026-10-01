<script setup lang="ts">
import { agentStory } from "./content";
</script>

<template>
  <section class="bg-default">
    <div
      class="mx-auto flex max-w-[90rem] flex-col gap-8 px-4 py-16 sm:px-8 sm:py-20 lg:flex-row lg:items-end lg:justify-between lg:px-12 lg:py-24"
    >
      <div>
        <h2
          class="text-4xl/10 font-semibold tracking-[-0.04em] text-highlighted text-balance sm:text-5xl/12"
        >
          Build your first Agent.
        </h2>
        <p class="mt-4 max-w-[44ch] text-lg/8 text-muted">
          The tutorial runs offline and needs no model key.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <UButton
          :to="agentStory.tutorialPath"
          label="Start the tutorial"
          trailing-icon="i-lucide-arrow-right"
          color="neutral"
          size="lg"
          class="closing-cta rounded-md px-4"
        />
        <NuxtLink
          to="/docs/agents"
          class="inline-flex min-h-10 items-center text-muted transition-colors hover:text-default focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          How Agents work
        </NuxtLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.closing-cta :deep(.iconify) {
  transition: transform 200ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .closing-cta:hover :deep(.iconify) {
    transform: translateX(0.25rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .closing-cta :deep(.iconify) {
    transition: none;
  }
}
</style>
