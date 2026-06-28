<script setup lang="ts">
const pillars = [
  { icon: "i-lucide-blocks", label: "Composable" },
  { icon: "i-lucide-globe", label: "Provider-agnostic" },
  { icon: "i-simple-icons-vite", label: "Just a Vite plugin" },
] as const;
</script>

<template>
  <section class="border-t border-default bg-muted/30">
    <div class="mx-auto max-w-7xl px-4 py-20 text-center sm:px-8 lg:px-12 lg:py-28">
      <h2 class="mx-auto max-w-[24ch] text-4xl font-semibold tracking-tight text-highlighted text-balance sm:text-5xl">
        One plugin. Any agent. Any host.
      </h2>
      <p class="mx-auto mt-5 max-w-[46ch] text-lg text-muted text-pretty">
        Install ViteHub, define an agent, and ship the same code anywhere.
      </p>

      <div class="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <NuxtLink
          to="/docs/getting-started/installation"
          class="inline-flex items-center justify-center gap-2 rounded-sm bg-inverted px-4 py-2.5 text-sm font-medium text-inverted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon name="i-lucide-rocket" class="size-4 shrink-0" aria-hidden="true" />
          Start building
        </NuxtLink>
        <NuxtLink
          to="/docs"
          class="inline-flex items-center justify-center gap-2 rounded-sm border border-default px-4 py-2.5 text-sm font-medium text-highlighted transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Read the docs
        </NuxtLink>
      </div>

      <ul class="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2" role="list">
        <li v-for="pillar in pillars" :key="pillar.label" class="inline-flex items-center gap-2 text-sm font-medium text-muted">
          <UIcon :name="pillar.icon" class="size-4 shrink-0" aria-hidden="true" />
          {{ pillar.label }}
        </li>
      </ul>
    </div>
  </section>
</template>
