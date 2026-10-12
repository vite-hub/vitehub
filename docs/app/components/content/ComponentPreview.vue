<script setup lang="ts">
import highlighter from "#mdc-highlighter";
import { useClipboard } from "@vueuse/core";
import { computed, defineAsyncComponent, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** Remove the stage padding for full-bleed examples such as chats and dashboards. */
    flush?: boolean;
    /** Example file name in `examples/`, without the `.vue` extension. */
    name: string;
    /** Reserve the live example's content height, in rem, before its module loads. */
    height?: number;
    /** Show a Reset control that remounts the example with its initial state. */
    reset?: boolean;
  }>(),
  {
    flush: false,
    reset: false,
  },
);

// Fixed panels keep their own viewport size. Small controls need much less space.
const previewHeights = new Map(Object.entries({
  CapabilityInspectorExample: 24,
  CapabilityInspectorFallbackExample: 20,
  ChatAppBlock: 36,
  ChatComposerExample: 26,
  ChatCustomMessageExample: 18,
  ChatExample: 28,
  ChatMessageExample: 16,
  ChatPromptStatusExample: 12,
  ChatStreamingExample: 24,
  CodeReviewBlock: 34,
  CodeViewExample: 24,
  FileDiffExample: 24,
  FileExample: 20,
  FileTreeControlledExample: 18,
  FileTreeExample: 20,
  InvocationDashboardBlock: 38,
  InvocationExample: 34,
  InvocationFailedExample: 30,
  InvocationInspectorCompactExample: 30,
  InvocationInspectorExample: 36,
  InvocationInspectorFailedExample: 36,
  InvocationListExample: 20,
  InvocationListPaginationExample: 20,
  InvocationListSlotsExample: 20,
  InvocationListStatusesExample: 24,
  InvocationPendingExample: 16,
  InvocationRunningExample: 28,
  MarkdownImageExample: 24,
  MarkdownMathExample: 14,
  MarkdownStreamingExample: 22,
  MessagePartsExample: 18,
  MessagePartsFilesExample: 18,
  MessagePartsToolStatesExample: 16,
  MessageScrollerExample: 18,
  MessageScrollerStreamingExample: 18,
  MultiFileDiffExample: 24,
  PatchDiffExample: 18,
  SessionExample: 30,
  SessionSlotsExample: 24,
  TimelineExample: 24,
  ToolListContractsExample: 16,
  ToolListExample: 20,
  TraceExample: 18,
  TraceFailedExample: 18,
}));
const previewHeight = computed(() => props.height ?? previewHeights.get(props.name) ?? 8);

const exampleModules = import.meta.glob("./examples/*.vue");
// SAFETY: Vite's raw eager glob returns each matching file's default export as a string.
const exampleSources = import.meta.glob("./examples/*.vue", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;
const examplePath = Object.keys(exampleModules).find((path) => path.endsWith(`/${props.name}.vue`));

if (!examplePath) {
  throw new Error(`Unknown component preview: ${props.name}`);
}

const loader = exampleModules[examplePath];
if (!loader) {
  throw new Error(`Missing component preview loader: ${props.name}`);
}

// SAFETY: Vue files loaded through Vite expose their component as the module default export.
const example = defineAsyncComponent(loader as () => Promise<{ default: object }>);
// The source panel shows the same file that the live example runs.
const source = (exampleSources[examplePath] || "").trim();
const sourceHeight = Math.min(32, source.split("\n").length * 1.5 + 2);
const fileName = `${props.name}.vue`;
const sourceFence = "`".repeat(
  Math.max(3, ...Array.from(source.matchAll(/`+/g), ([match]) => match.length + 1)),
);
const sourceBlock = `${sourceFence}vue\n${source}\n${sourceFence}`;
const sourceParserOptions = {
  highlight: {
    highlighter,
    theme: {
      light: "material-theme-lighter",
      default: "material-theme",
      dark: "material-theme-palenight",
    },
  },
};

const { copy, copied, isSupported } = useClipboard({ copiedDuring: 1600, legacy: true });
const copyLabel = computed(() => (copied.value ? "Copied" : `Copy ${fileName}`));

const resetKey = ref(0);
function resetExample() {
  resetKey.value++;
}
</script>

<template>
  <div
    class="component-preview not-prose my-6 overflow-hidden rounded-lg border border-default bg-default"
  >
    <div
      class="flex min-h-11 items-center justify-between gap-2 border-b border-default ps-1.5 pe-2 sm:pe-3"
    >
      <div class="flex min-w-0 items-center gap-2 ps-2">
        <span class="text-xs font-medium text-highlighted">Live example</span>
        <span class="hidden truncate font-mono text-xs text-muted sm:inline">{{ fileName }}</span>
      </div>

      <div class="flex min-w-0 items-center gap-1">
        <UButton
          v-if="reset"
          icon="i-lucide-rotate-ccw"
          label="Reset"
          color="neutral"
          size="xs"
          variant="ghost"
          class="component-preview-action"
          @click="resetExample"
        />
        <UButton
          v-if="isSupported"
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="copyLabel"
          :title="copyLabel"
          color="neutral"
          size="xs"
          variant="ghost"
          class="component-preview-action"
          @click="copy(source)"
        />
        <span class="sr-only" aria-live="polite">{{ copied ? `${fileName} copied` : "" }}</span>
      </div>
    </div>

    <div
      class="component-preview-stage min-w-0 bg-elevated/35"
      :class="{ 'component-preview-flush': flush }"
      :style="{ '--preview-content-height': `${previewHeight}rem` }"
    >
      <Suspense>
        <component :is="example" :key="resetKey" />

        <template #fallback>
          <div role="status" class="grid h-full place-items-center text-sm text-muted">
            Loading preview...
          </div>
        </template>
      </Suspense>
    </div>

    <div
      class="component-preview-source border-t border-default"
      :style="{ height: `${sourceHeight}rem` }"
    >
      <MDC :value="sourceBlock" :parser-options="sourceParserOptions" :tag="false" />
    </div>
  </div>
</template>

<style scoped>
.component-preview-stage {
  --preview-stage-padding: 1rem;
  height: calc(var(--preview-content-height) + 2 * var(--preview-stage-padding));
  overflow: auto;
  padding: var(--preview-stage-padding);
  scrollbar-gutter: stable;
}

@media (min-width: 40rem) {
  .component-preview-stage {
    --preview-stage-padding: 1.5rem;
  }
}

@media (min-width: 64rem) {
  .component-preview-stage {
    --preview-stage-padding: 2rem;
  }
}

.component-preview-stage.component-preview-flush {
  --preview-stage-padding: 0rem;
}

/* The 44px toolbar fits 36px touch targets without growing. */
@media (pointer: coarse) {
  .component-preview-action {
    min-height: 2.25rem;
  }

  .component-preview-action {
    min-width: 2.25rem;
    justify-content: center;
  }
}

.component-preview-source {
  overflow: auto;
}

.component-preview-source :deep(.code-block-wrapper) {
  margin: 0;
}

.component-preview-source :deep(pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
}
</style>
