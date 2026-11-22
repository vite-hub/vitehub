<script setup lang="ts">
import { render, Workspace, type WorkspaceExample, type WorkspaceFiles } from "@vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [
  { id: "user", label: "A user", group: "JSON", files: { "data.json": "{ \"name\": \"Ada\", \"role\": \"admin\" }\n" } },
  { id: "list", label: "A list", group: "JSON", files: { "data.json": "[1, 2, 3]\n" } },
];

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const runner = render(async (files: WorkspaceFiles) => ({
  html: `<pre>${escape(JSON.stringify(JSON.parse(files["data.json"] ?? ""), null, 2))}</pre>`,
}));
</script>

<template>
  <div class="h-[28rem]">
    <Workspace :examples :runner name="json" :share="false" />
  </div>
</template>
