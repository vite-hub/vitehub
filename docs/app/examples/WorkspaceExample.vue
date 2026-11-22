<script setup lang="ts">
import { webContainer, Workspace, type WorkspaceExample } from "@vite-hub/ui/workspace";

const examples: WorkspaceExample[] = [{
  id: "hello",
  label: "Hello server",
  open: "server.js",
  files: {
    "package.json": JSON.stringify({ name: "hello", type: "module", scripts: { dev: "node server.js" } }, null, 2),
    "server.js": "import { createServer } from \"node:http\"\n\ncreateServer((request, response) => response.end(\"Hello from the browser\"))\n  .listen(3000)\n",
  },
}];

const runner = webContainer({ port: 3000 });
</script>

<template>
  <div class="h-[28rem]">
    <Workspace :examples :runner name="hello" label="example" :share="false" />
  </div>
</template>
