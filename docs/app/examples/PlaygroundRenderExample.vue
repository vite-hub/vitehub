<script setup lang="ts">
import { PlaygroundRender, type PlaygroundFiles, type PlaygroundResult } from "@vite-hub/ui";

const presets = [
  { id: "user", label: "A user", group: "JSON", files: { "data.json": "{ \"name\": \"Ada\", \"role\": \"admin\" }\n" } },
  { id: "list", label: "A list", group: "JSON", files: { "data.json": "[1, 2, 3]\n" } },
];
const panes = [{ file: "data.json", label: "JSON", language: "json" }];

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Formats the JSON, or reports why it does not parse.
async function render(files: PlaygroundFiles): Promise<PlaygroundResult> {
  try {
    return { html: `<pre>${escape(JSON.stringify(JSON.parse(files["data.json"] ?? ""), null, 2))}</pre>` };
  }
  catch (error) {
    return { html: "", issues: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
</script>

<template>
  <div class="h-[28rem]">
    <PlaygroundRender :presets :panes :render />
  </div>
</template>
