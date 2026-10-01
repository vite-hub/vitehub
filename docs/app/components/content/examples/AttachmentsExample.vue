<script setup lang="ts">
import { useAgentAttachments } from "@vite-hub/ui";
import { ref } from "vue";

const input = ref<HTMLInputElement | null>(null);
const messages = ref<string[]>([]);
const attachments = useAgentAttachments({
  accept: "image/*,.txt,.log",
  maxFiles: 3,
  maxSize: 1024 * 1024,
  onReject(file, reason) {
    messages.value = [...messages.value, `${file.name} was rejected: ${reason}`];
  },
});

function onChange(event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLInputElement) || !target.files) return;
  attachments.add(target.files);
  target.value = "";
}

// Convert the raw files to AI SDK file parts only when the message is sent.
async function send() {
  const parts = await attachments.toFileParts();
  messages.value = [...messages.value, `Sent ${parts.length} file part(s): ${parts.map((part) => part.mediaType).join(", ")}`];
  attachments.clear();
}
</script>

<template>
  <div class="mx-auto max-w-xl space-y-3">
    <input ref="input" v-bind="attachments.inputProps.value" class="sr-only" tabindex="-1" @change="onChange">
    <div class="flex flex-wrap gap-2">
      <UButton label="Add files" icon="i-ph-paperclip-light" color="neutral" variant="outline" size="sm" @click="input?.click()" />
      <UButton
        label="Send"
        icon="i-lucide-arrow-up"
        color="neutral"
        size="sm"
        :disabled="attachments.files.value.length === 0"
        @click="send"
      />
    </div>
    <ul v-if="attachments.files.value.length" class="divide-y divide-default rounded-md border border-default bg-default">
      <li v-for="item in attachments.files.value" :key="item.id" class="flex items-center gap-3 p-2 text-sm">
        <img v-if="item.previewUrl" :src="item.previewUrl" alt="" class="size-8 rounded object-cover">
        <UIcon v-else name="i-ph-file-text-light" class="size-8 text-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ item.file.name }}</span>
        <UButton
          icon="i-lucide-x"
          :aria-label="`Remove ${item.file.name}`"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="attachments.remove(item.id)"
        />
      </li>
    </ul>
    <p v-else class="text-sm text-muted">Up to 3 images or text files, 1 MB each. Nothing is uploaded.</p>
    <ul class="space-y-1 font-mono text-xs text-muted" aria-live="polite">
      <li v-for="(message, index) in messages" :key="index">{{ message }}</li>
    </ul>
  </div>
</template>
