<script setup lang="ts">
import { type WorkspaceCursor, WorkspaceEditor, WorkspaceEditorHead, WorkspaceFileTree, WorkspaceShell, WorkspaceStatus } from "@vite-hub/ui/workspace";
import { computed, ref } from "vue";

const original: Record<string, string> = {
  "src/components/Greeting.vue": "<template>\n  <h1>Welcome back</h1>\n  <p>Your translations update while you type. Press Alt+Z or the button over the editor to wrap long lines.</p>\n</template>\n",
  "src/pages/index.astro": "---\nimport Greeting from \"../components/Greeting.vue\"\n---\n\n<Greeting />\n",
  "locales/de.json": "{ \"welcome\": \"Willkommen\" }\n",
  "package.json": "{ \"name\": \"glosa\" }\n",
};
const files = ref({ ...original });
const selected = ref("src/components/Greeting.vue");
const wrap = ref(false);
const cursor = ref<WorkspaceCursor>({ column: 1, line: 1 });
const edited = computed(() => Object.keys(files.value).filter(path => files.value[path] !== original[path]));
</script>

<template>
  <WorkspaceShell class="h-96" :storage-key="false">
    <template #files>
      <WorkspaceFileTree v-model:selected="selected" :paths="Object.keys(files)" :edited="edited" />
    </template>
    <template #editor-head>
      <WorkspaceEditorHead v-model:wrap="wrap" :path="selected" />
    </template>
    <template #editor>
      <WorkspaceEditor v-model="files[selected]" v-model:wrap="wrap" :path="selected" @cursor="cursor = $event" />
    </template>
    <template #status>
      <WorkspaceStatus :cursor="cursor" :path="selected" />
    </template>
    <template #preview>
      <p class="p-4 text-sm text-muted">
        Edit a file to see its dot in the tree.
      </p>
    </template>
  </WorkspaceShell>
</template>
