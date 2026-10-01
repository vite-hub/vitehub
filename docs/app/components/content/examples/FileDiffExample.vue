<script setup lang="ts">
import { parsePatchFiles } from "@vite-hub/ui";

const patch = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
 # Storefront
-Run \`npm start\`.
+Run \`pnpm dev\`.
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,3 +2,3 @@
   "scripts": {
-    "start": "vite"
+    "dev": "vite"
   }
`;

// Parse once, then render each file from its metadata.
const fileDiffs = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
</script>

<template>
  <div class="min-w-0 space-y-3">
    <AgentFileDiff
      v-for="fileDiff in fileDiffs"
      :key="fileDiff.name"
      :file-diff="fileDiff"
      :options="{ diffStyle: 'unified' }"
    />
  </div>
</template>
