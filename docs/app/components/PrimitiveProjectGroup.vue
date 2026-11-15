<script setup lang="ts">
import { Status } from "@vite-hub/ui";
import type { PrimitiveFramework, PrimitiveProjectVariant } from "~/data/primitive-landings/types";

const props = defineProps<{ variants: PrimitiveProjectVariant[] }>();
const framework = defineModel<PrimitiveFramework>({ default: "vite" });
const selectedPath = ref("");
const currentVariant = computed(() => props.variants.find((variant) => variant.framework === framework.value) ?? props.variants[0]);
const currentFile = computed(() => currentVariant.value?.files.find((file) => file.path === selectedPath.value) ?? currentVariant.value?.files[0]);
watch(currentVariant, (variant) => {
  selectedPath.value = variant?.files[0]?.path ?? "";
}, { immediate: true });
const frameworkItems = computed(() => props.variants.map((variant) => ({ label: variant.label, value: variant.framework })));
const fileItems = computed(() => currentVariant.value?.files.map((file) => ({ label: file.path, value: file.path })) ?? []);
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-default bg-muted">
    <!-- The tab strip sits on the bottom line of the header, so its line and the header line are one. -->
    <div class="flex flex-wrap items-end justify-between gap-x-3 border-b border-default px-4">
      <Status label="Project group" class="self-center py-3 text-muted" />
      <UTabs v-model="framework" :items="frameworkItems" :content="false" aria-label="Framework" />
    </div>
    <p v-if="currentVariant?.illustrative" class="border-b border-default px-4 py-3 text-xs text-muted">
      Illustrative pseudocode. This layout is not an executable starter. Follow the guide for setup and API examples.
    </p>
    <!-- The file column fits the longest path, so no name is cut or runs into the code. -->
    <div v-if="currentVariant" class="grid min-h-80 md:grid-cols-[minmax(12rem,max-content)_minmax(0,1fr)]">
      <nav class="min-w-0 border-b border-default p-2 md:border-b-0 md:border-r" aria-label="Project files">
        <UTabs v-model="selectedPath" :items="fileItems" :content="false" orientation="vertical" class="items-stretch font-mono" />
      </nav>
      <div class="min-w-0 overflow-auto p-4">
        <div class="mb-3 font-mono text-xs text-dimmed">{{ currentFile?.path }}</div>
        <pre class="overflow-x-auto font-mono text-xs leading-6 text-muted"><code>{{ currentFile?.content }}</code></pre>
      </div>
    </div>
  </div>
</template>
