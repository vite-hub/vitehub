// The code parts in the side layout of `WorkspaceShell`: `WorkspaceFileTree`, `WorkspaceEditorHead`, `WorkspaceEditor`,
// and `WorkspaceStatus`, with the files of a prototype section. `?section=gpu` is section 5 (`v-playground-render-gpu-
// engine`, wrap on) and `?section=glosa` is section 1 (`v-playground-examples-menu`). `&edited=1` marks the
// `edited` file of the section, `&wrap=0|1` overrides the wrap state, and `&theme=dark` puts the page in dark mode.
import { defineComponent, h, type PropType, ref } from "vue";

import { WorkspaceEditor } from "../../../../src/workspace/workspace-editor.ts";
import { WorkspaceEditorHead } from "../../../../src/workspace/workspace-editor-head.ts";
import { WorkspaceFileTree } from "../../../../src/workspace/workspace-file-tree.ts";
import { WorkspaceShell } from "../../../../src/workspace/workspace-shell.ts";
import { type WorkspaceCursor, WorkspaceStatus } from "../../../../src/workspace/workspace-status.ts";
import type { WorkspacePartFixture } from "../main.ts";

const model = `import { defineModel, features as f, layers as l, int6 } from "gpu-engine"

export default defineModel({
  name: "name-tagger",
  input: f.tokens({ max: 64, rows: [f.shape(), f.hash({ buckets: 128, k: 2 })] }),
  net: [l.embed(20), l.conv({ taps: 3 }), l.biScan(20), l.dense(20, "relu")],
  head: { kind: "tag", labels: ["start", "inside", "none"] },
  quant: int6({ qatFrom: 0.7 }),
  budgets: { brotliBytes: 5_000, macsPerToken: 3_200 },
})`;

const greeting = `<script setup lang="ts">
const name = "Ada"
</script>

<template>
  <h1>Welcome back, {{ name }}</h1>
  <p>Your translations update while you type.</p>
  <a href="/start">Start translating</a>
</template>`;

const sections = {
  glosa: {
    files: {
      "astro.config.mjs": "export default {}\n",
      "locales/de.json": "{}\n",
      "locales/es.json": "{}\n",
      "package.json": "{}\n",
      "src/components/Greeting.vue": greeting,
      "src/pages/index.astro": "---\n---\n",
    },
    edited: "locales/es.json",
    open: "src/components/Greeting.vue",
    wrap: false,
  },
  gpu: {
    files: {
      "data/dev.jsonl": "{}\n",
      "data/train.jsonl": "{}\n",
      "name-tagger.model.ts": model,
    },
    edited: "data/train.jsonl",
    open: "name-tagger.model.ts",
    wrap: true,
  },
};

const component = defineComponent({
  props: { params: { required: true, type: Object as PropType<URLSearchParams> } },
  setup(props) {
    const section = sections[props.params.get("section") === "glosa" ? "glosa" : "gpu"];
    document.documentElement.classList.toggle("dark", props.params.get("theme") === "dark");
    const files = ref<Record<string, string>>({ ...section.files });
    const selected = ref(section.open);
    const wrap = ref(props.params.has("wrap") ? props.params.get("wrap") === "1" : section.wrap);
    const cursor = ref<WorkspaceCursor>({ column: 1, line: 1 });
    const edited = props.params.get("edited") === "1" ? [section.edited] : [];
    return () => h(WorkspaceShell, { layout: "side", storageKey: false, style: "border: 0; border-radius: 0" }, {
      bar: () => h("span", { class: "vh-ws-muted" }, "bar"),
      files: () => [
        h("div", { class: "vh-ws-head" }, h("span", { class: "vh-ws-muted" }, "Files")),
        h(WorkspaceFileTree, { edited, paths: Object.keys(files.value), selected: selected.value, "onUpdate:selected": (path: string) => { selected.value = path; } }),
      ],
      "editor-head": () => h(WorkspaceEditorHead, { path: selected.value, wrap: wrap.value, "onUpdate:wrap": (next: boolean) => { wrap.value = next; } }),
      editor: () => h(WorkspaceEditor, {
        modelValue: files.value[selected.value],
        path: selected.value,
        wrap: wrap.value,
        onCursor: (next: WorkspaceCursor) => { cursor.value = next; },
        "onUpdate:modelValue": (value: string) => { files.value = { ...files.value, [selected.value]: value }; },
        "onUpdate:wrap": (next: boolean) => { wrap.value = next; },
      }),
      status: () => h(WorkspaceStatus, { cursor: cursor.value, path: selected.value }),
      preview: () => h("div", { style: "flex: 1" }),
    });
  },
});

export default { component, ready: ".vh-ws-editor .cm-content" } satisfies WorkspacePartFixture;
