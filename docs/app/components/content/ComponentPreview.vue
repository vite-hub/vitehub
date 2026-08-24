<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";

const props = withDefaults(
  defineProps<{
    flush?: boolean;
    name: string;
  }>(),
  {
    flush: false,
  },
);

const exampleModules = import.meta.glob("./examples/*.vue");
// SAFETY: Vite's raw eager glob returns each matching file's default export as a string.
const exampleSources = import.meta.glob("./examples/*.vue", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;
const examplePath = Object.keys(exampleModules).find((path) => path.endsWith(`/${props.name}.vue`));

if (!examplePath) {
  throw new Error(`Unknown component preview: ${props.name}`);
}

const loader = exampleModules[examplePath];
if (!loader) {
  throw new Error(`Missing component preview loader: ${props.name}`);
}

// SAFETY: Vue files loaded through Vite expose their component as the module default export.
const example = defineAsyncComponent(loader as () => Promise<{ default: object }>);
const source = (exampleSources[examplePath] || "").trim();
const sourceOpen = ref(false);
const sourceLabel = computed(() => (sourceOpen.value ? "Hide code" : "View code"));
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-lg border border-default bg-default">
    <div class="flex min-h-11 items-center justify-between border-b border-default px-3 sm:px-4">
      <div class="flex items-center gap-2 text-xs font-medium text-muted">
        <UIcon name="i-lucide-eye" class="size-3.5" />
        Preview
      </div>
      <UButton
        :label="sourceLabel"
        icon="i-lucide-code-2"
        :trailing-icon="sourceOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        color="neutral"
        size="sm"
        variant="ghost"
        @click="sourceOpen = !sourceOpen"
      />
    </div>

    <div
      class="component-preview-stage min-w-0 bg-elevated/35"
      :class="flush ? '' : 'p-4 sm:p-6 lg:p-8'"
    >
      <Suspense>
        <component :is="example" />

        <template #fallback>
          <div class="grid min-h-32 place-items-center text-sm text-muted">Loading preview…</div>
        </template>
      </Suspense>
    </div>

    <div v-if="sourceOpen" class="border-t border-default">
      <ProsePre
        :code="source"
        :filename="`${name}.vue`"
        language="vue"
        :ui="{
          root: '!my-0 !rounded-none',
          header: '!rounded-none !border-0 !border-b',
          base: '!rounded-none !border-0',
        }"
      >
        <code>{{ source }}</code>
      </ProsePre>
    </div>
  </div>
</template>
