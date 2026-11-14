<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";
import { computed } from "vue";
import { consoleComponentProp, consoleComponentWithProp } from "../client/editor";
import { useConsoleMediaPicker } from "../client/media";

import type { PropType } from "vue";
import type { ConsoleDocumentComponent } from "../definitions";

/**
 * A Comark component in the body editor, such as `::alert{type="info"}`. Block components show their tag and props in
 * a header above editable Markdown; inline ones show as a labeled chip. The site renders them with its own components,
 * so the editor shows structure, not the final look. `image` and `file` props pick from the Media picker of the section,
 * as `image()` and `file()` fields do, and store the served URL of the file, or its pathname when the store is not served.
 */
// Runtime props: a type-only `NodeViewProps` needs the SFC compiler to read @tiptap/vue-3 from disk, and the Vite+ dev
// server gives the compiler no file system.
const props = defineProps({ ...nodeViewProps, definition: { type: Object as PropType<ConsoleDocumentComponent>, required: true } });

const entries = computed(() => Object.entries(props.definition.props).map(([name, prop]) => {
  const value = consoleComponentProp(props.node.attrs.props ?? {}, name, prop.type);
  return { name, store: prop.store, type: prop.type, value: value === undefined ? prop.default : value };
}));
const editable = computed(() => props.editor.isEditable);
const picker = useConsoleMediaPicker();

async function choose(name: string, kind: "file" | "image", store: string | undefined): Promise<void> {
  if (!picker) return;
  const [item] = await picker.pick({ accept: kind === "image" ? ["image/*"] : undefined, files: [], kind, multiple: false, store });
  if (item) update(name, kind, picker.resolveSrc?.(item.src) ?? item.src);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value) === value ? value : JSON.stringify(value);
}

function update(name: string, type: string, raw: unknown): void {
  let value: unknown = raw;
  if (type === "number") value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (type === "json") {
    try {
      value = String(raw).trim() ? JSON.parse(String(raw)) : null;
    }
    catch {
      return;
    }
  }
  props.updateAttributes({ props: consoleComponentWithProp(props.node.attrs.props ?? {}, name, value) });
}
</script>

<template>
  <NodeViewWrapper
    v-if="definition.kind === 'inline'"
    as="span"
    class="vitehub-comark-inline rounded-md bg-elevated px-1 py-px text-[max(0.9em,0.75rem)] ring-1 ring-default ring-inset"
    :data-component="definition.name"
  >
    <NodeViewContent as="span" />
    <UPopover v-if="entries.length" :content="{ align: 'start' }">
      <!-- Inside running text, so it sizes with the text around it instead of taking a UButton size. -->
      <button
        type="button"
        contenteditable="false"
        class="ms-1 inline-flex rounded-md px-1 align-baseline font-mono text-[max(0.8em,0.75rem)] text-muted hover:bg-accented disabled:pointer-events-none"
        :disabled="!editable"
        :aria-label="`Edit ${definition.label} props`"
      >
        <UIcon name="i-lucide-settings-2" class="size-3" aria-hidden="true" />
      </button>
      <template #content>
        <div class="grid w-64 gap-3 p-3">
          <p class="text-xs font-medium text-highlighted">{{ definition.label }}</p>
          <label v-for="entry in entries" :key="entry.name" class="grid gap-1 text-xs text-muted">
            <span class="font-mono">{{ entry.name }}</span>
            <USwitch v-if="entry.type === 'boolean'" :model-value="entry.value === true" @update:model-value="update(entry.name, entry.type, $event)" />
            <span v-else-if="entry.type === 'image' || entry.type === 'file'" class="flex gap-1">
              <UInput class="min-w-0 flex-1" :model-value="String(entry.value ?? '')" @update:model-value="update(entry.name, entry.type, $event)" />
              <UButton
                v-if="picker"
                variant="ghost"
                :icon="entry.type === 'image' ? 'i-lucide-image-plus' : 'i-lucide-paperclip'"
                :aria-label="entry.type === 'image' ? `Choose an image for ${entry.name}` : `Choose a file for ${entry.name}`"
                @click="choose(entry.name, entry.type, entry.store)"
              />
            </span>
            <UInput
              v-else
              :model-value="entry.type === 'json' ? (entry.value === null || entry.value === undefined ? '' : JSON.stringify(entry.value)) : String(entry.value ?? '')"
              :type="entry.type === 'number' ? 'number' : 'text'"
              :class="entry.type === 'json' ? 'font-mono' : undefined"
              @update:model-value="update(entry.name, entry.type, $event)"
            />
          </label>
        </div>
      </template>
    </UPopover>
  </NodeViewWrapper>
  <NodeViewWrapper v-else class="vitehub-comark-block my-3 rounded-lg ring-1 ring-default" :data-component="definition.name">
    <div contenteditable="false" class="flex min-h-8 select-none items-center gap-2 border-b border-default px-3 text-xs text-muted">
      <UIcon name="i-lucide-component" class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="font-mono text-highlighted">::{{ definition.name }}</span>
      <UPopover v-if="entries.length" :content="{ align: 'start' }">
        <UButton
          variant="ghost"
          size="xs"
          class="min-w-0 font-mono"
          :disabled="!editable"
          :aria-label="`Edit ${definition.label} props`"
        >
          <span v-for="entry in entries" :key="entry.name" class="truncate">{{ entry.name }}=<span class="text-highlighted">{{ display(entry.value) }}</span></span>
        </UButton>
        <template #content>
          <div class="grid w-64 gap-3 p-3">
            <p class="text-xs font-medium text-highlighted">{{ definition.label }}</p>
            <label v-for="entry in entries" :key="entry.name" class="grid gap-1 text-xs text-muted">
              <span class="font-mono">{{ entry.name }}</span>
              <USwitch v-if="entry.type === 'boolean'" :model-value="entry.value === true" @update:model-value="update(entry.name, entry.type, $event)" />
              <span v-else-if="entry.type === 'image' || entry.type === 'file'" class="flex gap-1">
                <UInput class="min-w-0 flex-1" :model-value="String(entry.value ?? '')" @update:model-value="update(entry.name, entry.type, $event)" />
                <UButton
                  v-if="picker"
                  variant="ghost"
                  :icon="entry.type === 'image' ? 'i-lucide-image-plus' : 'i-lucide-paperclip'"
                  :aria-label="entry.type === 'image' ? `Choose an image for ${entry.name}` : `Choose a file for ${entry.name}`"
                  @click="choose(entry.name, entry.type, entry.store)"
                />
              </span>
              <UInput
                v-else
                :model-value="entry.type === 'json' ? (entry.value === null || entry.value === undefined ? '' : JSON.stringify(entry.value)) : String(entry.value ?? '')"
                :type="entry.type === 'number' ? 'number' : 'text'"
                :class="entry.type === 'json' ? 'font-mono' : undefined"
                @update:model-value="update(entry.name, entry.type, $event)"
              />
            </label>
          </div>
        </template>
      </UPopover>
      <span v-if="definition.description" class="ms-auto hidden truncate sm:inline">{{ definition.description }}</span>
    </div>
    <NodeViewContent class="px-4 py-1" />
  </NodeViewWrapper>
</template>
