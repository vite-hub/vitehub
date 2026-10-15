<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper } from "@tiptap/vue-3";
import { computed } from "vue";

import type { NodeViewProps } from "@tiptap/vue-3";
import type { ConsoleDocumentComponent } from "../definitions";

/**
 * A Comark component in the body editor, such as `::alert{type="info"}`. Block components show their tag and props in
 * a header above editable Markdown; inline ones show as a labeled chip. The site renders them with its own components,
 * so the editor shows structure, not the final look.
 */
const props = defineProps<NodeViewProps & { definition: ConsoleDocumentComponent }>();

const entries = computed(() => Object.entries(props.definition.props).map(([name, prop]) => ({ name, type: prop.type, value: props.node.attrs[name] })));
const editable = computed(() => props.editor.isEditable);

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
  props.updateAttributes({ [name]: value });
}
</script>

<template>
  <NodeViewWrapper
    v-if="definition.kind === 'inline'"
    as="span"
    class="vitehub-comark-inline rounded-sm bg-elevated px-1 py-px text-[0.9em] ring-1 ring-default ring-inset"
    :data-component="definition.name"
  >
    <NodeViewContent as="span" />
  </NodeViewWrapper>
  <NodeViewWrapper v-else class="vitehub-comark-block my-3 rounded-lg ring-1 ring-default" :data-component="definition.name">
    <div contenteditable="false" class="flex min-h-8 select-none items-center gap-2 border-b border-default px-3 text-xs text-muted">
      <UIcon name="i-lucide-component" class="size-3.5 shrink-0" aria-hidden="true" />
      <span class="font-mono text-highlighted">::{{ definition.name }}</span>
      <UPopover v-if="entries.length" :content="{ align: 'start' }">
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 rounded-sm px-1 font-mono hover:bg-elevated focus-visible:outline-2 disabled:pointer-events-none"
          :disabled="!editable"
          :aria-label="`Edit ${definition.label} props`"
        >
          <span v-for="entry in entries" :key="entry.name" class="truncate">{{ entry.name }}=<span class="text-highlighted">{{ display(entry.value) }}</span></span>
        </button>
        <template #content>
          <div class="grid w-64 gap-3 p-3">
            <p class="text-xs font-medium text-highlighted">{{ definition.label }}</p>
            <label v-for="entry in entries" :key="entry.name" class="grid gap-1 text-xs text-muted">
              <span class="font-mono">{{ entry.name }}</span>
              <USwitch v-if="entry.type === 'boolean'" :model-value="entry.value === true" @update:model-value="update(entry.name, entry.type, $event)" />
              <UInput
                v-else
                :model-value="entry.type === 'json' ? (entry.value === null || entry.value === undefined ? '' : JSON.stringify(entry.value)) : String(entry.value ?? '')"
                :type="entry.type === 'number' ? 'number' : 'text'"
                :ui="{ base: entry.type === 'json' ? 'font-mono text-xs' : '' }"
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
