<script setup lang="ts">
import { CopyButton, Markdown } from "@vite-hub/ui";
import { computed, defineComponent, h, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { consoleBytes } from "../client/format";
import type { ConsoleSkillFile } from "../skills";
import ConsoleSessionCodePreview from "./console-session-code-preview.vue";
import "./console-session.css";

const props = defineProps<{ file: ConsoleSkillFile; paths: readonly string[] }>();
const views = [
  { label: "Preview", value: "preview" },
  { label: "Source", value: "source" },
];
const view = ref<string | number>("preview");
const raw = computed(() => view.value === "source");
const markdown = computed(() => /\.md$/i.test(props.file.path));
// A final newline ends the last line. It does not start another one.
const lines = computed(() => props.file.content ? props.file.content.split("\n").length - (props.file.content.endsWith("\n") ? 1 : 0) : 0);
const route = useRoute();
const copyError = ref(false);
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
        // Preserve bare percent signs while keeping URL-encoded links intact.
        const target = new URL(link.href.replace(/%(?![\da-f]{2})/gi, "%25"), base);
        if (target.origin === "https://bundled.invalid") {
          path = decodeURIComponent(target.pathname.slice(1));
          hash = target.hash;
        }
      } catch { /* Keep malformed links as text links. */ }
      if (path === undefined || link.href.startsWith("#")) return h("a", { ...attrs, href: link.href }, slots.default?.());
      // A relative link to a file outside the bundle would open a Console page, so it stays text.
      return props.paths.includes(path)
        ? h(RouterLink, { ...attrs, to: { query: { ...route.query, path }, hash } }, slots)
        : h("span", { ...attrs, title: "This file is not bundled with this Agent." }, slots.default?.());
    };
  },
});
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Skill file preview">
    <!-- No vertical padding: the tabs rest on the bottom border, so the tab line and the border are one line. -->
    <header class="flex min-h-11 flex-wrap items-center gap-x-3 border-b border-default px-3 sm:px-4">
      <p class="flex min-w-0 flex-1 basis-64 items-start gap-2 py-3 font-mono text-xs leading-5 text-highlighted">
        <UIcon name="i-lucide-file-text" class="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <span class="min-w-0 [overflow-wrap:anywhere]">{{ file.path }}</span>
      </p>
      <UTabs v-if="markdown" v-model="view" :items="views" :content="false" class="self-end" aria-label="File view" />
      <CopyButton :value="file.content" label="Copy" aria-label="Copy file contents" size="xs" @copy="copyError = false" @error="copyError = true" />
    </header>
    <p v-if="copyError" role="alert" class="px-4 pt-2 text-xs text-error">Could not copy. Select the file text to copy it.</p>
    <div class="min-h-0 flex-1 overflow-auto">
      <!-- The typeset grain would draw a box around the text column, so the preview turns it off. -->
      <Markdown v-if="markdown && !raw" class="mx-auto max-w-[75ch] break-words px-4 py-7 [--comark-grain:none] sm:px-10" :value="file.content" :components="{ a: SkillLink }" />
      <ConsoleSessionCodePreview v-else :content="file.content" :path="file.path" :wrap="true" />
    </div>
    <footer class="flex min-h-8 flex-wrap items-center justify-between gap-x-4 border-t border-default px-3 py-1 text-xs text-muted sm:px-4">
      <span>Bundled file · Read only</span>
      <span class="tabular-nums">{{ lines }} {{ lines === 1 ? "line" : "lines" }} · {{ consoleBytes(file.size) }}</span>
    </footer>
  </section>
</template>
