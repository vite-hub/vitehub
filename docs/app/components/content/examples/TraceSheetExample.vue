<script setup lang="ts">
const files = ["server/api/chat.post.ts", "server/agents/reviewer.ts", "nuxt.config.ts", "package.json"];
</script>

<template>
  <Trace class="w-full max-w-sm">
    <USlideover title="Explored 4 files" description="Files read while preparing the response.">
      <button type="button">
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-folder-open-light" /></TraceIcon>
          <TraceTitle>Explored {{ files.length }} files</TraceTitle>
          <TraceIcon><UIcon name="i-ph-caret-right-light" /></TraceIcon>
        </TraceLine>
      </button>
      <template #body>
        <ul class="flex flex-col gap-2 font-mono text-xs">
          <li v-for="file in files" :key="file">
            {{ file }}
          </li>
        </ul>
      </template>
    </USlideover>
  </Trace>
</template>
