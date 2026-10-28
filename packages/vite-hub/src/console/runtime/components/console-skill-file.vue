<script setup lang="ts">
import { AgentMarkdown } from "@vite-hub/ui";
import { computed, ref } from "vue";
import type { ConsoleSkillFile } from "../skills";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import "./console-session.css";

const props = defineProps<{ file: ConsoleSkillFile }>();
const raw = ref(false);
const markdown = computed(() => /\.md$/i.test(props.file.path));
const body = computed(() => props.file.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
const copied = ref(false);
const copyError = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(props.file.content);
    copied.value = true;
    copyError.value = false;
  } catch {
    copyError.value = true;
  }
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Skill file preview">
    <header class="flex min-h-11 items-center gap-3 border-b border-default px-3">
      <UIcon name="i-ph-file-text-light" class="size-4 shrink-0 text-muted" />
      <h2 class="min-w-0 flex-1 truncate font-mono text-xs font-normal text-highlighted" :title="file.path">{{ file.path }}</h2>
      <UButton v-if="markdown" :label="raw ? 'Preview' : 'Source'" :aria-pressed="raw" size="xs" color="neutral" variant="ghost" @click="raw = !raw" />
      <UButton :label="copied ? 'Copied' : 'Copy'" :icon="copied ? 'i-ph-check-light' : 'i-ph-copy-light'" aria-label="Copy file contents" size="xs" color="neutral" variant="ghost" @click="copy" />
    </header>
    <p v-if="copyError" role="alert" class="px-4 pt-2 text-xs text-error">Could not copy. Select the file text to copy it.</p>
    <div class="min-h-0 flex-1 overflow-auto">
      <AgentMarkdown v-if="markdown && !raw" class="skills-file__markdown mx-auto max-w-[75ch] px-6 py-7 text-sm leading-relaxed text-toned sm:px-10" :value="body" />
      <ConsoleSessionCodePreview v-else :content="file.content" :path="file.path" :wrap="true" />
    </div>
    <footer class="flex min-h-8 flex-wrap items-center justify-between gap-x-4 border-t border-default px-3 py-1 text-xs text-muted">
      <span>Bundled file · Read only</span>
      <span class="tabular-nums">{{ file.content.split('\n').length }} lines · {{ file.size.toLocaleString() }} bytes</span>
    </footer>
  </section>
</template>

<style scoped>
.skills-file__markdown :deep(h1) { font-size: 1.5rem; line-height: 1.25; font-weight: 600; color: var(--ui-text-highlighted); text-wrap: balance; margin-bottom: 1rem; }
.skills-file__markdown :deep(h2) { font-size: 1rem; line-height: 1.3; font-weight: 600; color: var(--ui-text-highlighted); text-wrap: balance; margin: 1.75rem 0 .75rem; }
.skills-file__markdown :deep(h3) { font-size: .875rem; font-weight: 600; margin: 1.25rem 0 .5rem; }
.skills-file__markdown :deep(p) { margin-block: .75rem; overflow-wrap: anywhere; text-wrap: pretty; }
.skills-file__markdown :deep(ul), .skills-file__markdown :deep(ol) { padding-inline-start: 1.5rem; margin-block: .75rem; }
.skills-file__markdown :deep(ul) { list-style-type: disc; }
.skills-file__markdown :deep(ol) { list-style-type: decimal; }
.skills-file__markdown :deep(li) { margin-block: .35rem; }
.skills-file__markdown :deep(code) { font-size: .8125rem; }
.skills-file__markdown :deep(pre) { overflow: auto; padding: 1rem; background: var(--ui-bg-muted); border-radius: var(--ui-radius); }
.skills-file__markdown :deep(a) { color: var(--ui-primary); text-decoration: underline; }
</style>
