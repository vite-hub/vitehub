<script setup lang="ts">
import ConsoleIcon from "../../packages/vite-hub/src/console/runtime/components/console-icon.vue";

// Every icon name in the Console sources. The names are literals, also the ones that a page binds with `:name`.
const sources = import.meta.glob<string>(["../../packages/vite-hub/src/console/**/*.{js,ts,vue}", "!**/*.test.*"], { eager: true, import: "default", query: "?raw" });
const names = [...new Set(Object.values(sources).flatMap(source => source.match(/\bi-[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []))].sort();
// How Console tags place their icons: in running text at 1em, and in a flex row with a fixed size.
const contexts = [
  { classes: "", wrapper: "" },
  { classes: "", wrapper: "inline-flex items-center gap-1.5" },
  { classes: "size-4", wrapper: "inline-flex items-center gap-1.5" },
  { classes: "size-3.5 shrink-0 opacity-70", wrapper: "" },
];
</script>

<template>
  <main :data-names="names.length">
    <template v-for="name in names" :key="name">
      <div v-for="(context, index) in contexts" :key="index" class="flex gap-6 text-sm" :data-name="name" :data-context="index">
        <span data-side="nuxt-ui" :class="context.wrapper">a<UIcon :name="name" :class="context.classes" aria-hidden="true" />b</span>
        <span data-side="console" :class="context.wrapper">a<ConsoleIcon :name="name" :class="context.classes" aria-hidden="true" />b</span>
      </div>
    </template>
  </main>
</template>
