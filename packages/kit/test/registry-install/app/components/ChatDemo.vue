<script setup lang="ts">
import { ref, useTemplateRef } from "vue";
import { CopyIcon, RefreshCwIcon } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Message, MessageActions, MessageContent, MessageMarkdown } from "@/components/ui/message";
import { MessageList, MessageListScrollButton } from "@/components/ui/message-list";
import type { PromptInputMessage } from "@/components/ui/prompt-input";
import { PromptInput, PromptInputAttach, PromptInputAttachments, PromptInputSubmit, PromptInputTextarea, PromptInputToolbar } from "@/components/ui/prompt-input";
import type { ToolCallState } from "@/components/ui/tool-call";
import { ToolCall } from "@/components/ui/tool-call";

interface DemoMessage {
  id: number;
  from: "user" | "assistant";
  text: string;
  files?: string[];
  tools?: { name: string; state: ToolCallState; input?: unknown; output?: unknown; errorText?: string; defaultOpen?: boolean }[];
}

const reply = `Here is the deploy plan for **acme-web**:

1. Build the app with \`vite build\`.
2. Upload the output to the \`production\` bucket.
3. Point the domain at the new version.

| Step | Time |
| --- | --- |
| Build | 42 s |
| Upload | 8 s |

\`\`\`ts
export default defineSchedule({ cron: "0 3 * * *" })
\`\`\`

Read more in the [deploy guide](https://vitehub.dev).`;

const messages = ref<DemoMessage[]>([
  { id: 1, from: "user", text: "How do I deploy acme-web every night?" },
  {
    id: 2,
    from: "assistant",
    text: reply,
    tools: [
      { name: "readProject", state: "output-available", input: { project: "acme-web" }, output: { framework: "nuxt", host: "cloudflare" } },
      { name: "listDeployments", state: "output-error", input: { limit: 5 }, errorText: "The token cannot read deployments.", defaultOpen: true },
      { name: "publishPreview", state: "approval-responded" },
      { name: "updateDomain", state: "approval-requested", input: { domain: "acme.example" } },
      { name: "updateProject", state: "approval-requested", defaultOpen: false },
    ],
  },
  { id: 3, from: "user", text: "Run it now and attach the log.", files: ["build.log"] },
  { id: 4, from: "assistant", text: "Starting the deploy", tools: [{ name: "deploy", state: "input-available", input: { project: "acme-web", target: "production" } }] },
]);
const input = ref("");
const pending = ref(false);
const streaming = ref(true);
const list = useTemplateRef("list");

function send(message: PromptInputMessage) {
  list.value?.scrollToBottom();
  messages.value.push({ id: Date.now(), from: "user", text: message.text, files: message.files.map((file) => file.name) });
  pending.value = true;
}
</script>

<template>
  <div class="flex h-[36rem] flex-col overflow-hidden rounded-xl border bg-background">
    <MessageList ref="list">
      <Message v-for="message in messages" :key="message.id" :from="message.from">
        <ToolCall
          v-for="tool in message.tools"
          :key="tool.name"
          :name="tool.name"
          :state="tool.state"
          :input="tool.input"
          :output="tool.output"
          :error-text="tool.errorText"
          :default-open="tool.defaultOpen"
        />
        <MessageContent>
          <MessageMarkdown v-if="message.from === 'assistant'" :value="message.text" :streaming="streaming && message.id === 4" />
          <template v-else>{{ message.text }}</template>
        </MessageContent>
        <div v-if="message.files?.length" class="flex gap-1 text-xs text-muted-foreground">
          <span v-for="file in message.files" :key="file" class="rounded-md bg-muted px-1.5 py-0.5">{{ file }}</span>
        </div>
        <MessageActions v-if="message.from === 'assistant'">
          <Button variant="ghost" size="icon-xs" aria-label="Copy"><CopyIcon /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Retry"><RefreshCwIcon /></Button>
        </MessageActions>
      </Message>
      <MessageListScrollButton />
    </MessageList>
    <div class="mx-auto w-full max-w-3xl px-4 pb-4">
      <PromptInput v-model="input" :pending="pending" data-demo="prompt" @submit="send" @stop="pending = false">
        <PromptInputAttachments />
        <PromptInputTextarea placeholder="Ask the agent" />
        <PromptInputToolbar>
          <PromptInputAttach />
          <PromptInputSubmit />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  </div>
</template>
