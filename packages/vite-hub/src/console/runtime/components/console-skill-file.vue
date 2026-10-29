<script setup lang="ts">
import { Markdown } from "@vite-hub/ui";
import { useClipboard } from "@vueuse/core";
import { computed, defineComponent, h, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { consoleBytes } from "../client/format";
import type { ConsoleSkillFile } from "../skills";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import "./console-session.css";

const props = defineProps<{ file: ConsoleSkillFile; paths: readonly string[] }>();
const raw = ref(false);
const markdown = computed(() => /\.md$/i.test(props.file.path));
const route = useRoute();
const { copy: copyContent, copied, isSupported: clipboardSupported } = useClipboard({ source: () => props.file.content });
const copyError = ref(false);
async function copy() {
  try {
    if (!clipboardSupported.value) throw new Error("Clipboard unavailable");
    await copyContent();
    copyError.value = false;
  } catch {
    copyError.value = true;
  }
}
const SkillLink = defineComponent({
  inheritAttrs: false,
  props: { href: { type: String, default: "" } },
  setup(link, { attrs, slots }) {
    return () => {
      let path: string | undefined;
      let hash: string | undefined;
      try {
        const base = new URL("https://bundled.invalid");
        // Encode each part, so a file name with "%", "?", or "#" resolves as a name.
        base.pathname = `/${props.file.path.split("/").map(encodeURIComponent).join("/")}`;
        const target = new URL(link.href, base);
        if (target.origin === "https://bundled.invalid") {
          path = decodeURIComponent(target.pathname.slice(1));
          hash = target.hash;
        }
      } catch { /* Keep malformed links as text links. */ }
      return path && props.paths.includes(path) && !link.href.startsWith("#")
        ? h(RouterLink, { ...attrs, to: { query: { ...route.query, path }, hash } }, slots)
        : h("a", { ...attrs, href: link.href }, slots.default?.());
    };
  },
});
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Skill file preview">
    <header class="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-default px-3 py-2 sm:px-4">
      <p class="flex min-w-0 flex-1 basis-64 items-start gap-2 font-mono text-xs leading-5 text-highlighted">
        <UIcon name="i-ph-file-text-light" class="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <span class="min-w-0 [overflow-wrap:anywhere]">{{ file.path }}</span>
      </p>
      <div v-if="markdown" role="group" aria-label="File view" class="flex items-center gap-1">
        <UButton label="Preview" :aria-pressed="!raw" size="xs" color="neutral" :variant="raw ? 'ghost' : 'soft'" @click="raw = false" />
        <UButton label="Source" :aria-pressed="raw" size="xs" color="neutral" :variant="raw ? 'soft' : 'ghost'" @click="raw = true" />
      </div>
      <UButton :label="copied ? 'Copied' : 'Copy'" :icon="copied ? 'i-ph-check-light' : 'i-ph-copy-light'" aria-label="Copy file contents" size="xs" color="neutral" variant="ghost" @click="copy" />
    </header>
    <span role="status" class="sr-only">{{ copied ? 'File contents copied' : '' }}</span>
    <p v-if="copyError" role="alert" class="px-4 pt-2 text-xs text-error">Could not copy. Select the file text to copy it.</p>
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- The typeset grain would draw a box around the text column, so the preview turns it off. -->
      <Markdown v-if="markdown && !raw" class="mx-auto max-w-[75ch] break-words px-4 py-7 [--comark-grain:none] sm:px-10" :value="file.content" :components="{ a: SkillLink }" />
      <ConsoleSessionCodePreview v-else :content="file.content" :path="file.path" :wrap="true" />
    </div>
    <footer class="flex min-h-8 flex-wrap items-center justify-between gap-x-4 border-t border-default px-3 py-1 text-xs text-muted sm:px-4">
      <span>Bundled file · Read only</span>
      <span class="tabular-nums">{{ file.content.split('\n').length }} lines · {{ consoleBytes(file.size) }}</span>
    </footer>
  </section>
</template>
