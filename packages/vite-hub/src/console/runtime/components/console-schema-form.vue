<script setup lang="ts">
import { computed } from "vue";

import { describeConsoleSchemaFields } from "../client/documents";
import ConsoleSchemaField from "./console-schema-field.vue";

/**
 * A form generated from an object JSON Schema with Nuxt UI fields. It covers strings, text, numbers, booleans, enums,
 * dates, string lists, nested objects, and Blob references, and edits any other shape as JSON. Pass server issues in
 * `errors`, keyed by dotted field path.
 */
const props = defineProps<{
  disabled?: boolean;
  errors?: Readonly<Record<string, string[]>>;
  schema: Record<string, unknown>;
}>();

const model = defineModel<Record<string, unknown>>({ required: true });

const fields = computed(() => describeConsoleSchemaFields(props.schema));
const formErrors = computed(() => props.errors ?? {});

function update(name: string, value: unknown): void {
  const next = { ...model.value };
  if (value === undefined) delete next[name];
  else next[name] = value;
  model.value = next;
}
</script>

<template>
  <UForm :state="model" class="grid gap-5" :disabled="disabled">
    <ConsoleSchemaField
      v-for="field in fields"
      :key="field.name"
      :disabled="disabled"
      :errors="formErrors"
      :field="field"
      :model-value="model[field.name]"
      @update:model-value="update(field.name, $event)"
    />
    <p v-if="!fields.length" class="text-xs text-muted">This collection has no fields. Edit the body below.</p>
  </UForm>
</template>
