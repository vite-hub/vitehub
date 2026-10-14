<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { consoleFieldValueIssue } from "../client/documents";

import type { ConsoleSchemaField } from "../client/documents";

defineOptions({ name: "ConsoleSchemaField" });

const props = defineProps<{
  disabled?: boolean;
  /** Server issues keyed by dotted field path, such as `author.name`. */
  errors: Readonly<Record<string, string[]>>;
  field: ConsoleSchemaField;
  /** Dotted path of the parent object field, or empty at the top level. */
  parent?: string;
  /** Label of the parent object field, so a nested issue reads `Author name is required.` */
  parentLabel?: string;
  /** Whether the parent object field is optional. Its required children may stay empty while the whole object is. */
  parentOptional?: boolean;
}>();

const model = defineModel<unknown>();

const path = computed(() => (props.parent ? `${props.parent}.${props.field.name}` : props.field.name));
const inputId = computed(() => `field-${path.value.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
const error = computed(() => {
  const own = props.errors[path.value] ?? [];
  // Issues inside a list or JSON value, such as `tags.0`, belong to this field.
  const nested = props.field.kind === "object" ? [] : Object.entries(props.errors)
    .filter(([key]) => key.startsWith(`${path.value}.`))
    .flatMap(([, messages]) => messages);
  const messages = [...own, ...nested];
  return messages.length ? messages.join(" ") : blurIssue.value;
});

// Text-like fields validate when focus leaves them, then clear the message as soon as the value is valid again.
// Choices and dates leave validation to the save, since their menus move focus while someone is still choosing.
const blurValidated = computed(() => ["integer", "number", "string", "string-list", "text"].includes(props.field.kind));
const blurIssue = ref<string>();
const labelled = computed(() => (props.parentLabel ? { ...props.field, label: `${props.parentLabel} ${props.field.label.toLowerCase()}` } : props.field));

function validate(): void {
  if (!blurValidated.value) return;
  // An optional object such as Author may stay empty; the save reports a half-filled one.
  const field = props.parentOptional ? { ...labelled.value, required: false } : labelled.value;
  blurIssue.value = consoleFieldValueIssue(field, model.value);
}

watch(model, (value) => {
  if (blurIssue.value && !consoleFieldValueIssue(labelled.value, value)) blurIssue.value = undefined;
});

function record(value: unknown): Record<string, unknown> {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

const text = computed({
  get: () => (String(model.value) === model.value ? model.value : model.value === undefined || model.value === null ? "" : String(model.value)),
  set: (value: string) => {
    model.value = value;
  },
});

const number = computed({
  get: () => (Number(model.value) === model.value && Number.isFinite(model.value) ? model.value : null),
  set: (value: number | null | undefined) => {
    model.value = value === null || value === undefined || Number.isNaN(value) ? undefined : value;
  },
});

const boolean = computed({
  get: () => model.value === true,
  set: (value: boolean) => {
    model.value = value;
  },
});

const list = computed({
  get: () => (Array.isArray(model.value) ? model.value.map(String) : []),
  set: (value: string[]) => {
    model.value = value;
  },
});

const enumItems = computed(() => (props.field.enum ?? []).map(option => ({ label: String(option), value: option })));
const enumValue = computed({
  get: () => (String(model.value) === model.value || Number(model.value) === model.value ? model.value : undefined),
  set: (value: string | number | undefined) => {
    model.value = value;
  },
});

// Dates are stored as ISO strings. A date field keeps `YYYY-MM-DD`; a date-time field edits the UTC date and time.
const datePart = computed({
  get: () => (String(model.value) === model.value ? model.value.slice(0, 10) : ""),
  set: (value: string) => {
    if (props.field.kind === "date") {
      model.value = value || undefined;
      return;
    }
    model.value = value ? `${value}T${timePart.value || "00:00"}:00.000Z` : undefined;
  },
});
const timePart = computed({
  get: () => (String(model.value) === model.value && model.value.length >= 16 ? model.value.slice(11, 16) : ""),
  set: (value: string) => {
    if (!datePart.value) return;
    model.value = `${datePart.value}T${value || "00:00"}:00.000Z`;
  },
});

// JSON fields keep their text while it is invalid, so a half-typed value is not lost.
const jsonText = ref("");
const jsonError = ref<string>();
watch(
  () => model.value,
  (value) => {
    if (props.field.kind !== "json") return;
    try {
      if (JSON.stringify(JSON.parse(jsonText.value || "null")) === JSON.stringify(value ?? null)) return;
    }
    catch {
      // Replace invalid text with the current value below.
    }
    jsonText.value = value === undefined ? "" : JSON.stringify(value, null, 2);
    jsonError.value = undefined;
  },
  { immediate: true },
);
function updateJson(value: string): void {
  jsonText.value = value;
  if (!value.trim()) {
    model.value = undefined;
    jsonError.value = undefined;
    return;
  }
  try {
    model.value = JSON.parse(value);
    jsonError.value = undefined;
  }
  catch {
    jsonError.value = "Enter valid JSON.";
  }
}

const blob = computed(() => {
  const value = record(model.value);
  const hint = record(props.field.schema["x-vitehub-blob"]);
  return {
    contentType: String(value.contentType ?? ""),
    kind: hint.kind === "image" ? "Image" : "File",
    pathname: String(value.pathname ?? ""),
    size: Number.isFinite(value.size) ? Number(value.size) : undefined,
    store: String(hint.store ?? "default"),
  };
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function child(name: string): unknown {
  return record(model.value)[name];
}

function updateChild(name: string, value: unknown): void {
  const next = { ...record(model.value) };
  if (value === undefined) delete next[name];
  else next[name] = value;
  model.value = next;
}
</script>

<template>
  <fieldset v-if="field.kind === 'object'" class="grid gap-4 rounded-md border border-default p-4" :aria-describedby="field.description ? `${inputId}-description` : undefined">
    <legend class="px-1 text-xs font-medium text-highlighted">
      {{ field.label }}<span v-if="field.required" class="ms-0.5 text-error">*</span>
    </legend>
    <p v-if="field.description" :id="`${inputId}-description`" class="-mt-2 text-xs text-muted">{{ field.description }}</p>
    <ConsoleSchemaField
      v-for="nested in field.fields"
      :key="nested.name"
      :disabled="disabled"
      :errors="errors"
      :field="nested"
      :model-value="child(nested.name)"
      :parent="path"
      :parent-label="field.label"
      :parent-optional="!field.required"
      @update:model-value="updateChild(nested.name, $event)"
    />
    <p v-if="errors[path]?.length" class="text-xs text-error">{{ errors[path]!.join(" ") }}</p>
  </fieldset>

  <UFormField
    v-else
    :name="path"
    :label="field.label"
    :description="field.description"
    :required="field.required"
    :error="error ?? jsonError"
    :ui="{ label: 'text-xs', description: 'text-xs' }"
    @focusout="validate"
  >
    <UInput v-if="field.kind === 'string'" :id="inputId" v-model="text" class="w-full" :disabled="disabled" :maxlength="field.maxLength" />
    <UTextarea v-else-if="field.kind === 'text'" :id="inputId" v-model="text" class="w-full" autoresize :rows="3" :disabled="disabled" :maxlength="field.maxLength" />
    <UInputNumber
      v-else-if="field.kind === 'number' || field.kind === 'integer'"
      :id="inputId"
      v-model="number"
      class="w-full max-w-60"
      :disabled="disabled"
      :min="field.minimum"
      :max="field.maximum"
      :step="field.kind === 'integer' ? 1 : 0.01"
      :increment="{ color: 'neutral' }"
      :decrement="{ color: 'neutral' }"
    />
    <USwitch v-else-if="field.kind === 'boolean'" :id="inputId" v-model="boolean" :disabled="disabled" />
    <USelect
      v-else-if="field.kind === 'enum'"
      :id="inputId"
      v-model="enumValue"
      class="w-full max-w-80"
      :items="enumItems"
      :disabled="disabled"
      :placeholder="field.required ? 'Choose…' : 'None'"
    />
    <UInput v-else-if="field.kind === 'date'" :id="inputId" v-model="datePart" type="date" class="w-full max-w-60" :disabled="disabled" />
    <div v-else-if="field.kind === 'date-time'" class="flex items-center gap-2">
      <UInput :id="inputId" v-model="datePart" type="date" class="min-w-0 flex-1" :disabled="disabled" :aria-label="`${field.label} date`" />
      <UInput v-model="timePart" type="time" class="w-28 shrink-0" :disabled="disabled || !datePart" :aria-label="`${field.label} time, UTC`" />
      <span class="text-xs text-dimmed">UTC</span>
    </div>
    <UInputTags v-else-if="field.kind === 'string-list'" :id="inputId" v-model="list" class="w-full" :disabled="disabled" placeholder="Add and press Enter" />
    <div v-else-if="field.kind === 'blob'" class="flex items-center gap-3 rounded-md border border-dashed border-default px-3 py-2.5" :aria-describedby="`${inputId}-blob`">
      <UIcon :name="blob.kind === 'Image' ? 'i-lucide-image' : 'i-lucide-paperclip'" class="size-4 shrink-0 text-muted" />
      <div class="min-w-0 flex-1">
        <p class="truncate font-mono text-xs text-highlighted">{{ blob.pathname || `No ${blob.kind.toLowerCase()}` }}</p>
        <p :id="`${inputId}-blob`" class="truncate text-xs text-muted">
          <template v-if="blob.pathname">{{ [blob.contentType, blob.size === undefined ? '' : formatBytes(blob.size), `Blob store ${blob.store}`].filter(Boolean).join(" · ") }}</template>
          <template v-else>Blob store {{ blob.store }}. Choosing media from the Console is not available yet.</template>
        </p>
      </div>
      <UBadge color="neutral" variant="soft" size="sm" label="Read-only" />
    </div>
    <UTextarea
      v-else
      :id="inputId"
      :model-value="jsonText"
      class="w-full font-mono"
      :ui="{ base: 'font-mono text-xs' }"
      autoresize
      :rows="3"
      :disabled="disabled"
      placeholder="JSON value"
      @update:model-value="updateJson(String($event ?? ''))"
    />
  </UFormField>
</template>
