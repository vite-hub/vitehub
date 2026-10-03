<script setup lang="ts">
import highlighter from "#mdc-highlighter";
import { useClipboard } from "@vueuse/core";
import { computed, defineAsyncComponent, nextTick, ref, useId } from "vue";

const props = withDefaults(
  defineProps<{
    /** Remove the stage padding for full-bleed examples such as chats and dashboards. */
    flush?: boolean;
    /** Example file name in `examples/`, without the `.vue` extension. */
    name: string;
    /** Show a Reset control that remounts the example with its initial state. */
    reset?: boolean;
  }>(),
  {
    flush: false,
    reset: false,
  },
);

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
// The Code tab shows the same file that the Preview tab runs.
const source = (exampleSources[examplePath] || "").trim();
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

type PreviewTab = "preview" | "code";
const tabs: { id: PreviewTab; icon: string; label: string }[] = [
  { id: "preview", icon: "i-lucide-eye", label: "Preview" },
  { id: "code", icon: "i-lucide-code-2", label: "Code" },
];
const activeTab = ref<PreviewTab>("preview");
const id = useId();
const tabId = (tab: PreviewTab) => `${id}-${tab}-tab`;
const panelId = (tab: PreviewTab) => `${id}-${tab}-panel`;
const tabButtons = ref<HTMLButtonElement[]>([]);

async function focusTab(index: number) {
  const tab = tabs[(index + tabs.length) % tabs.length];
  if (!tab) return;
  activeTab.value = tab.id;
  await nextTick();
  tabButtons.value.find((button) => button.id === tabId(tab.id))?.focus();
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  if (event.key === "ArrowRight") void focusTab(index + 1);
  else if (event.key === "ArrowLeft") void focusTab(index - 1);
  else if (event.key === "Home") void focusTab(0);
  else if (event.key === "End") void focusTab(tabs.length - 1);
  else return;
  event.preventDefault();
}

const { copy, copied, isSupported } = useClipboard({ copiedDuring: 1600, legacy: true });
const copyLabel = computed(() => (copied.value ? "Copied" : `Copy ${fileName}`));

const resetKey = ref(0);
function resetExample() {
  resetKey.value++;
  activeTab.value = "preview";
}
</script>

<template>
  <div class="component-preview not-prose my-6 overflow-hidden rounded-lg border border-default bg-default">
    <div class="flex min-h-11 items-center justify-between gap-2 border-b border-default ps-1.5 pe-2 sm:pe-3">
      <div role="tablist" aria-label="Example view" class="flex items-center gap-0.5">
        <button
          v-for="(tab, index) in tabs"
          :id="tabId(tab.id)"
          :key="tab.id"
          ref="tabButtons"
          type="button"
          role="tab"
          class="component-preview-tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="panelId(tab.id)"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
          @keydown="onTabKeydown($event, index)"
        >
          <UIcon :name="tab.icon" class="size-3.5" aria-hidden="true" />
          {{ tab.label }}
        </button>
      </div>

      <div class="flex min-w-0 items-center gap-1">
        <span
          v-if="activeTab === 'code'"
          class="hidden truncate font-mono text-xs text-muted sm:inline"
        >{{ fileName }}</span>
        <UButton
          v-if="reset && activeTab === 'preview'"
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
      v-show="activeTab === 'preview'"
      :id="panelId('preview')"
      role="tabpanel"
      :aria-labelledby="tabId('preview')"
      class="component-preview-stage min-w-0 bg-elevated/35"
      :class="flush ? '' : 'p-4 sm:p-6 lg:p-8'"
    >
      <Suspense>
        <component :is="example" :key="resetKey" />

        <template #fallback>
          <div class="grid min-h-32 place-items-center text-sm text-muted">Loading preview…</div>
        </template>
      </Suspense>
    </div>

    <div
      v-show="activeTab === 'code'"
      :id="panelId('code')"
      role="tabpanel"
      :aria-labelledby="tabId('code')"
      class="component-preview-source"
    >
      <MDC :value="sourceBlock" :parser-options="sourceParserOptions" :tag="false" />
    </div>
  </div>
</template>

<style scoped>
.component-preview-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: calc(var(--ui-radius) * 1.5);
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ui-text-muted);
  transition: color 0.15s, background-color 0.15s;
}

.component-preview-tab:hover {
  color: var(--ui-text-highlighted);
}

.component-preview-tab[aria-selected="true"] {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}

.component-preview-tab:focus-visible {
  outline: 2px solid var(--ui-border-inverted);
  outline-offset: 1px;
}

/* The 44px toolbar fits 36px touch targets without growing. */
@media (pointer: coarse) {
  .component-preview-tab,
  .component-preview-action {
    min-height: 2.25rem;
  }

  .component-preview-action {
    min-width: 2.25rem;
    justify-content: center;
  }
}

.component-preview-source :deep(pre) {
  max-height: 32rem;
  margin: 0;
  border: 0;
  border-radius: 0;
}
</style>
