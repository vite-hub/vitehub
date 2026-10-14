<script setup lang="ts">
const output = `$ node --version
v24.18.0`;

const error = `$ pnpm dev
Error: listen EADDRINUSE: address already in use :::3000
    at Server.setupListenHandle [as _listen2] (node:net:1908:16)`;
</script>

<template>
  <div class="flex w-full max-w-md flex-col gap-4">
    <Trace>
      <TraceCollapsible default-open>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
            <TraceTitle>Ran node --version</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap class="max-h-64">{{ output }}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceCollapsible default-open>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
            <TraceTitle>Failed to run pnpm dev</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent wrap class="max-h-64">{{ error }}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  </div>
</template>
