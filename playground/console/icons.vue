<script setup lang="ts">
import ConsoleIcon from "../../packages/vite-hub/src/console/runtime/components/console-icon.vue";

const sources = import.meta.glob<string>(["../../packages/vite-hub/src/console/**/*.{js,ts,vue}", "!**/*.test.*"], { eager: true, import: "default", query: "?raw" });
const names = [...new Set(Object.values(sources).flatMap(source => source.match(/\bi-[a-z0-9]+(?:-[a-z0-9]+)+/g) ?? []))].sort();
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
