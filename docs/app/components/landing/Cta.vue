<script setup lang="ts">
const pillars = [
  { icon: "i-lucide-bot", label: "Agents" },
  { icon: "i-lucide-server-cog", label: "Server Primitives" },
  { icon: "i-lucide-globe", label: "Provider-agnostic" },
] as const;
</script>

<template>
  <section class="border-t border-default bg-muted/30">
    <div class="mx-auto max-w-7xl px-4 py-20 text-center sm:px-8 lg:px-12 lg:py-28">
      <h2 class="mx-auto max-w-[24ch] text-4xl font-semibold tracking-tight text-highlighted text-balance sm:text-5xl">
        Build Agents. Keep the server portable.
      </h2>
      <p class="mx-auto mt-5 max-w-[46ch] text-lg text-muted text-pretty">
        Start with one product lane. Compose the other only when your application needs it.
      </p>

      <div class="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <NuxtLink
          to="/docs/getting-started/first-agent"
          class="inline-flex items-center justify-center gap-2 rounded-sm bg-inverted px-4 py-2.5 text-sm font-medium text-inverted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <UIcon name="i-lucide-rocket" class="size-4 shrink-0" aria-hidden="true" />
          Build an Agent
        </NuxtLink>
        <NuxtLink
          to="/docs/getting-started/first-server-primitive"
          class="inline-flex items-center justify-center gap-2 rounded-sm border border-default px-4 py-2.5 text-sm font-medium text-highlighted transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Use Server Primitives
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
