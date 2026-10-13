<script setup lang="ts">
import { nuxtHubMigration } from "./content";
</script>

<template>
  <section class="border-b border-default bg-muted/20">
    <div
      class="mx-auto grid max-w-[90rem] gap-8 px-4 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:px-12"
    >
      <div>
        <h2
          class="text-2xl/8 font-semibold tracking-[-0.03em] text-highlighted text-balance sm:text-3xl/9"
        >
          Coming from NuxtHub?
        </h2>
        <p class="mt-3 max-w-[48ch] text-base/7 text-muted">
          KV, Blob, and Database move with new imports. Queue, Workflow, Schedule, Auth, and Agents
          come with the same module.
        </p>
        <NuxtLink
          :to="nuxtHubMigration.to"
          class="group mt-3 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-highlighted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          Read the migration guide
          <UIcon
            name="i-lucide-arrow-right"
            class="landing-cta-arrow size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </NuxtLink>
      </div>

      <ul class="divide-y divide-default border border-default bg-default font-mono text-xs sm:text-sm" role="list">
        <li
          v-for="entry in nuxtHubMigration.imports"
          :key="entry.from"
          class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-3"
        >
          <span class="truncate text-muted">{{ entry.from }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" aria-label="becomes" />
          <span class="truncate text-highlighted">{{ entry.to }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
@media (hover: hover) and (pointer: fine) {
  .group:hover .landing-cta-arrow {
    transform: translateX(0.25rem);
  }
}
</style>
