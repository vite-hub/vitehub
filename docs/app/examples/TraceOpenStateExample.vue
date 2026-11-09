<script setup lang="ts">
const open = ref(false);
</script>

<template>
  <div class="flex w-full max-w-sm flex-col items-start gap-4">
    <TraceCollapsible default-open>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
          <TraceTitle>Ran node --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap class="max-h-64">{{ "$ node --version\nv24.18.0" }}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
    <TraceCollapsible v-model:open="open">
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
          <TraceTitle>Ran pnpm --version</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap class="max-h-64">{{ "$ pnpm --version\n10.33.4" }}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
    <UButton color="neutral" variant="outline" size="sm" @click="open = !open">
      {{ open ? "Hide" : "Show" }} the pnpm output
    </UButton>
  </div>
</template>
