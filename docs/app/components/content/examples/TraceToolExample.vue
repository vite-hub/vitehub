<script setup lang="ts">
import type { DynamicToolUIPart } from "ai";

const parts: DynamicToolUIPart[] = [
  {
    type: "dynamic-tool",
    toolCallId: "call_node",
    toolName: "runCommand",
    state: "output-available",
    input: { command: "node --version" },
    output: { stdout: "v24.18.0" },
  },
  {
    type: "dynamic-tool",
    toolCallId: "call_npm",
    toolName: "runCommand",
    state: "output-available",
    input: { command: "npm --version" },
    output: { stdout: "11.6.2" },
  },
  {
    type: "dynamic-tool",
    toolCallId: "call_pnpm",
    toolName: "runCommand",
    state: "output-error",
    input: { command: "pnpm --version" },
    errorText: "command not found: pnpm",
  },
];

function command(part: DynamicToolUIPart) {
  const input = part.input;
  return input instanceof Object && "command" in input ? String(input.command) : part.toolName;
}

function output(part: DynamicToolUIPart) {
  if (part.state === "output-error") return part.errorText;
  if (part.state !== "output-available") return "";
  const value = part.output;
  return value instanceof Object && "stdout" in value ? String(value.stdout) : JSON.stringify(value);
}
</script>

<template>
  <div class="flex w-full max-w-sm flex-col gap-4 text-sm">
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="muted">
          <BubbleContent>Which package managers are installed?</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
    <Message>
      <MessageContent class="gap-4">
        <Trace>
          <TraceCollapsible v-for="part in parts" :key="part.toolCallId">
            <TraceCollapsibleTrigger>
              <TraceLine :status="part.state === 'output-error' ? 'error' : undefined">
                <TraceIcon><UIcon name="i-ph-terminal-light" /></TraceIcon>
                <TraceTitle>{{ part.state === "output-error" ? "Failed to run" : "Ran" }} {{ command(part) }}</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <CodeBlock size="sm" :variant="part.state === 'output-error' ? 'destructive' : 'default'">
                <CodeBlockContent wrap class="max-h-64">{{ output(part) }}</CodeBlockContent>
              </CodeBlock>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
        <p>Node 24 and npm 11 are installed. pnpm is not.</p>
      </MessageContent>
    </Message>
  </div>
</template>
