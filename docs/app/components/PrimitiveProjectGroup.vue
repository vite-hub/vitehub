<script setup lang="ts">
import type { PrimitiveFramework, PrimitiveProjectVariant } from "~/data/primitive-landings/types";

const props = defineProps<{ variants: PrimitiveProjectVariant[] }>();
const framework = defineModel<PrimitiveFramework>({ default: "vite" });
const selectedPath = ref("");
const currentVariant = computed(() => props.variants.find((variant) => variant.framework === framework.value) ?? props.variants[0]);
const currentFile = computed(() => currentVariant.value?.files.find((file) => file.path === selectedPath.value) ?? currentVariant.value?.files[0]);
watch(currentVariant, (variant) => {
  selectedPath.value = variant?.files[0]?.path ?? "";
}, { immediate: true });
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-default bg-elevated">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b border-default px-4 py-3">
      <div class="flex items-center gap-2 text-xs text-muted">
        <span class="size-2 rounded-full bg-primary" aria-hidden="true" />
        <span>Project group</span>
      </div>
      <div class="flex rounded-lg border border-default p-0.5" role="tablist" aria-label="Framework">
        <button
          v-for="variant in variants"
          :key="variant.framework"
          type="button"
          role="tab"
          :aria-selected="framework === variant.framework"
          class="rounded-md px-2.5 py-1 text-xs transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-elevated/80 focus-visible:outline-2 focus-visible:outline-primary"
          :class="framework === variant.framework ? 'bg-elevated text-highlighted' : 'text-muted'"
          @click="framework = variant.framework"
        >
          {{ variant.label }}
        </button>
      </div>
    </div>
    <p v-if="currentVariant?.illustrative" class="border-b border-default px-4 py-3 text-xs text-muted">
      Illustrative pseudocode. This layout is not an executable starter. Follow the guide for setup and API examples.
    </p>
    <div v-if="currentVariant" class="grid min-h-80 md:grid-cols-[12rem_minmax(0,1fr)]">
      <nav class="border-b border-default p-2 md:border-b-0 md:border-r" aria-label="Project files">
        <button
          v-for="file in currentVariant.files"
          :key="file.path"
          type="button"
          class="block w-full rounded-md px-3 py-2 text-left font-mono text-xs transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-elevated hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
          :class="currentFile?.path === file.path ? 'bg-elevated text-highlighted' : 'text-muted'"
          @click="selectedPath = file.path"
        >
          {{ file.path }}
        </button>
      </nav>
      <div class="min-w-0 overflow-auto p-4">
        <div class="mb-3 font-mono text-xs text-dimmed">{{ currentFile?.path }}</div>
        <pre class="overflow-x-auto font-mono text-xs leading-6 text-muted"><code>{{ currentFile?.content }}</code></pre>
      </div>
    </div>
  </div>
</template>
