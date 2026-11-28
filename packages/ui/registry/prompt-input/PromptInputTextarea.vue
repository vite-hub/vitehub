<script setup lang="ts">
import { onMounted, ref } from "vue";
import { usePromptInput } from "./context.ts";
import { touchOnly } from "./files.ts";

const context = usePromptInput();
// Read after mount, so the server and the client render the same first markup.
const touch = ref(false);
onMounted(() => {
  touch.value = touchOnly();
});

// Enter sends and Shift+Enter adds a line. Composing text with an input method never sends. On a touch-only device the
// on-screen keyboard has no Shift+Enter, so Enter adds a line and the send button sends.
function onKeydown(event: KeyboardEvent) {
  if (!context || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (touchOnly()) return;
  event.preventDefault();
  if (context.status.value === "ready" && !context.disabled.value && !context.readonly.value) context.requestSubmit();
}

// A pasted picture is attached. Other files are attached only when the clipboard has no text, so a paste from an
// office app that also carries a picture of the text pastes the text.
async function onPaste(event: ClipboardEvent) {
  const clipboard = event.clipboardData;
  if (!context?.takesFiles.value || !clipboard) return;
  const hasText = clipboard.getData("text/plain").length > 0;
  const files = Array.from(clipboard.files).filter((file) => file.type.startsWith("image/") || !hasText);
  if (files.length > 0) await context.addFiles(files, () => event.preventDefault());
}

function onInput(event: Event) {
  if (context && event.target instanceof HTMLTextAreaElement) context.text.value = event.target.value;
}
</script>

<template>
  <textarea
    v-if="context"
    data-slot="prompt-input-textarea"
    :aria-label="context.label.value"
    :enterkeyhint="touch ? 'enter' : 'send'"
    :placeholder="context.placeholder.value"
    :aria-busy="context.readonly.value ? 'true' : undefined"
    :disabled="context.disabled.value"
    :readonly="context.readonly.value"
    rows="1"
    :value="context.text.value"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
  />
</template>
