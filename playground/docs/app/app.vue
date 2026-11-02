<script setup lang="ts">
import manifest from "#docs/manifest"

// The docs UI is ported in another change. This app shows the page list and the assistant only.
const sections = manifest.sections
</script>

<template>
  <UApp>
    <main class="mx-auto max-w-2xl p-6 text-sm">
      <NuxtLink to="/" class="font-medium text-highlighted">
        Lumen
      </NuxtLink>
      <nav v-for="section in sections" :key="section.id" class="mt-4">
        <p class="text-muted">
          {{ section.title }}
        </p>
        <NuxtLink v-for="page in section.pages" :key="page.path" :to="page.path" class="block" active-class="text-highlighted">
          {{ page.title }}
        </NuxtLink>
      </nav>
      <NuxtPage class="mt-6" />
    </main>
    <DocsAssistant />
  </UApp>
</template>
