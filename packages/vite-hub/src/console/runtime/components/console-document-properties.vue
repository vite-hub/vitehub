<script setup lang="ts">
import { computed, ref } from "vue";

import { describeConsoleSchemaFields } from "../client/documents";
import ConsoleSchemaField from "./console-schema-field.vue";

/**
 * The fields of a document as Notion-style property rows, generated from the object JSON Schema of the collection.
 * Optional fields without a value fold behind "Show N more", unless they have an issue or `unfolded` is set. Pass server
 * issues in `errors`, keyed by dotted field path. Rows before the fields, such as the id, go in the default slot.
 */
const props = defineProps<{
  disabled?: boolean;
  errors?: Readonly<Record<string, string[]>>;
  /** Fields the page shows elsewhere, such as the title. */
  exclude?: readonly string[];
  schema: Record<string, unknown>;
  /** Show every field, for documents whose fields are the whole page, such as JSON and YAML data. */
  unfolded?: boolean;
}>();

const emit = defineEmits<{ submit: [] }>();

const model = defineModel<Record<string, unknown>>({ required: true });
const showAll = ref(false);
// Fields edited in this view stay visible, so clearing one does not fold it away under the cursor.
const touched = ref(new Set<string>());

const fields = computed(() => describeConsoleSchemaFields(props.schema).filter(field => !props.exclude?.includes(field.name)));
const formErrors = computed(() => props.errors ?? {});

function empty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return !value.length;
  return value instanceof Object && Object.values(value).every(empty);
}

/** Fields that fold away: optional, empty, and valid. A field someone just filled stays visible. */
const folded = computed(() => props.unfolded ? [] : fields.value.filter(field => !field.required && field.kind !== "boolean" && !touched.value.has(field.name) && empty(model.value[field.name])
  && !Object.keys(formErrors.value).some(key => key === field.name || key.startsWith(`${field.name}.`))));
const visible = computed(() => (showAll.value ? fields.value : fields.value.filter(field => !folded.value.includes(field))));

function update(name: string, value: unknown): void {
  if (!touched.value.has(name)) touched.value = new Set(touched.value).add(name);
  const next = { ...model.value };
  if (value === undefined) delete next[name];
  else next[name] = value;
  model.value = next;
}
</script>

<template>
  <div class="grid gap-px" role="group" aria-label="Properties">
    <slot />
    <ConsoleSchemaField
      v-for="field in visible"
      :key="field.name"
      :disabled="disabled"
      :errors="formErrors"
      :field="field"
      :model-value="model[field.name]"
      @update:model-value="update(field.name, $event)"
      @submit="emit('submit')"
    />
    <button
      v-if="folded.length"
      type="button"
      class="flex h-8 w-fit items-center gap-2 rounded-md px-1.5 text-[13px] text-dimmed hover:text-highlighted focus-visible:outline-2"
      :aria-expanded="showAll"
      @click="showAll = !showAll"
    >
      <UIcon :name="showAll ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 opacity-70" aria-hidden="true" />
      {{ showAll ? `Hide ${folded.length} empty` : `Show ${folded.length} more` }}
    </button>
  </div>
</template>
