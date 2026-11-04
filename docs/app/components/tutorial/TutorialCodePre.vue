<script setup lang="ts">
import { tutorialActionsKey } from "~/utils/tutorial-actions";
import { parseCurl } from "~/utils/runnable-tutorial";

// A lesson code block. A file of the app gets "Show in editor". A request to the app gets "Run in workspace", and the
// response shows under the block, because the preview frame can only send GET requests.
const props = defineProps<{
  code?: string
  language?: string | null
  filename?: string | null
  highlights?: number[]
  meta?: string | null
  class?: string | null
}>()

const actions = inject(tutorialActionsKey, undefined);
const root = useTemplateRef<HTMLElement>("root");
// Parsed pages pass no `code`, so read the command from the rendered block.
const command = ref(props.code);
onMounted(() => { command.value ??= root.value?.querySelector("pre")?.textContent ?? undefined; });
const isFile = computed(() => !!props.filename && !!actions?.available && actions.paths.includes(props.filename));
const isRequest = computed(() => !!actions?.available && !!command.value && parseCurl(command.value) !== undefined);
const output = ref<string>();
const pending = ref(false);

async function run() {
  if (!actions || !command.value) return;
  pending.value = true;
  try {
    output.value = await actions.run(command.value);
  }
  finally {
    pending.value = false;
  }
}
</script>

<template>
  <div ref="root" class="vh-tutorial-code">
    <DocsCodePre v-bind="props"><slot /></DocsCodePre>
    <UButton
      v-if="isFile"
      class="vh-tutorial-code-action"
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-lucide-file-code"
      label="Show in editor"
      @click="actions?.show(filename!)"
    />
    <div v-if="isRequest" class="vh-tutorial-run">
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-play"
        :label="pending ? 'Running' : 'Run in workspace'"
        :loading="pending"
        :disabled="!actions?.running || pending"
        @click="run"
      />
      <span v-if="!actions?.running" class="text-xs text-muted">Available when the dev server runs.</span>
    </div>
    <pre v-if="output !== undefined" class="vh-tutorial-run-output" aria-live="polite"><code>{{ output }}</code></pre>
  </div>
</template>

<style scoped>
.vh-tutorial-code {
  position: relative;
}

/* Inside the file name bar, before the copy button. */
.vh-tutorial-code-action {
  position: absolute;
  top: 0.4375rem;
  right: 2.5rem;
}

.vh-tutorial-run {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: -0.5rem;
  margin-bottom: 1rem;
}

.vh-tutorial-run-output {
  margin-block: 0 1rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg-muted);
  padding: 0.75rem;
  font-size: 0.8125rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
