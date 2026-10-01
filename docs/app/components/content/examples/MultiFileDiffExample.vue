<script setup lang="ts">
import type { FileContents } from "@vite-hub/ui";
import { ref } from "vue";

const oldFile: FileContents = {
  name: "src/retry.ts",
  contents: `export async function retry(task: () => Promise<void>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await task()
    } catch {}
  }
}
`,
};
const newFile: FileContents = {
  name: "src/retry.ts",
  contents: `export async function retry(task: () => Promise<void>, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (attempt === attempts - 1) throw error
    }
  }
}
`,
};
const diffStyle = ref<"unified" | "split">("split");
</script>

<template>
  <div class="min-w-0 space-y-3">
    <div class="flex gap-1" role="group" aria-label="Diff layout">
      <UButton
        v-for="style in ['split', 'unified'] as const"
        :key="style"
        :label="style"
        color="neutral"
        size="xs"
        :variant="diffStyle === style ? 'solid' : 'outline'"
        :aria-pressed="diffStyle === style"
        @click="diffStyle = style"
      />
    </div>
    <AgentMultiFileDiff :old-file="oldFile" :new-file="newFile" :options="{ diffStyle }" />
  </div>
</template>
