<script setup lang="ts">
import { CalendarDate, parseDate, Time } from "@internationalized/date";
import { computed, ref, watch } from "vue";

import { consoleFieldValueIssue, consoleValueSummary } from "../client/schema-form";
import ConsoleMediaField from "./console-media-field.vue";
import ConsolePropertyRow from "./console-property-row.vue";

import type { ConsoleSchemaField, ConsoleSchemaFieldKind } from "../client/schema-form";

defineOptions({ name: "ConsoleSchemaField" });

/**
 * One schema form field as a property row. The control follows the JSON Schema of the field: text, long text, number,
 * switch, choice, date and time, tags, a nested object as a one-line summary that expands in place, a Blob reference
 * chosen from the media library, or JSON for any other shape.
 */
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

const emit = defineEmits<{
  /** ⌘Enter in a text area. */
  submit: [];
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
  return messages.length ? messages.join(" ") : blurIssue.value ?? jsonError.value;
});
const nestedError = computed(() => Object.keys(props.errors).some(key => key.startsWith(`${path.value}.`)));
const missing = computed(() => props.field.required && !props.parentOptional && props.field.kind !== "boolean" && props.field.kind !== "object"
  && (model.value === undefined || model.value === null || model.value === "" || (Array.isArray(model.value) && !model.value.length)));

const icons: Record<ConsoleSchemaFieldKind, string> = {
  blob: "i-lucide-image",
  boolean: "i-lucide-square-check",
  date: "i-lucide-calendar",
  "date-time": "i-lucide-calendar-clock",
  enum: "i-lucide-circle-chevron-down",
  integer: "i-lucide-hash",
  json: "i-lucide-braces",
  number: "i-lucide-hash",
  object: "i-lucide-list-tree",
  string: "i-lucide-type",
  "string-list": "i-lucide-tags",
  text: "i-lucide-align-left",
};
const icon = computed(() => (props.field.kind === "blob" && record(props.field.schema["x-vitehub-blob"]).kind !== "image" ? "i-lucide-paperclip" : icons[props.field.kind]));

// Date and time segments size to their digits instead of fixed cells, so `9/1/2026 00:00` reads as one value.
const segment = "px-0.5 tabular-nums data-[segment=day]:w-auto data-[segment=month]:w-auto data-[segment=year]:w-auto data-[segment=hour]:w-auto data-[segment=minute]:w-auto data-[segment=literal]:px-0";

// Ghost controls: no fill, a border on hover and focus (Notion property values, Geist input ring).
const ghost = "bg-transparent hover:bg-transparent focus:bg-transparent disabled:bg-transparent ring-0 hover:ring-1 hover:ring-inset hover:ring-(--ui-border) focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-(--ui-border-accented) aria-invalid:ring-1 aria-invalid:ring-error/60 text-base md:text-sm";

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

function onTextKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    emit("submit");
  }
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
function stored(): string {
  return String(model.value) === model.value ? model.value : "";
}
const date = computed<CalendarDate | undefined>({
  get: () => {
    try {
      return stored().length >= 10 ? parseDate(stored().slice(0, 10)) : undefined;
    }
    catch {
      return undefined;
    }
  },
  set: (value) => {
    if (!value) {
      model.value = undefined;
      return;
    }
    const day = value.toString();
    model.value = props.field.kind === "date" ? day : `${day}T${(time.value ?? new Time(0, 0)).toString().slice(0, 5)}:00.000Z`;
  },
});
const time = computed<Time | undefined>({
  get: () => {
    const match = /T(\d{2}):(\d{2})/.exec(stored());
    return match ? new Time(Number(match[1]), Number(match[2])) : undefined;
  },
  set: (value) => {
    if (!date.value) return;
    model.value = `${date.value.toString()}T${(value ?? new Time(0, 0)).toString().slice(0, 5)}:00.000Z`;
  },
});
const calendarOpen = ref(false);

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
  const hint = record(props.field.schema["x-vitehub-blob"]);
  const accept = Array.isArray(hint.accept) ? hint.accept.filter(entry => String(entry) === entry) : undefined;
  return { accept, kind: hint.kind === "image" ? "image" as const : "file" as const };
});

// A nested object reads as one line, such as `London · GB · 51.5, -0.12`, and expands in place.
const expanded = ref(false);
watch(nestedError, (invalid) => {
  if (invalid) expanded.value = true;
}, { immediate: true });
const summary = computed(() => consoleValueSummary(props.field, model.value));

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
  <div v-if="field.kind === 'object'" class="grid">
    <ConsolePropertyRow :icon="icon" :label="field.label" :description="field.description" :control="inputId" :error="errors[path]?.join(' ')">
      <button
        :id="inputId"
        type="button"
        class="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left text-base hover:ring-1 md:text-sm hover:ring-(--ui-border) hover:ring-inset focus-visible:ring-1 focus-visible:ring-(--ui-border-accented) focus-visible:ring-inset focus-visible:outline-none"
        :aria-expanded="expanded"
        :aria-controls="`${inputId}-fields`"
        @click="expanded = !expanded"
      >
        <span class="truncate" :class="summary ? 'text-highlighted' : 'text-dimmed'">{{ summary || "Empty" }}</span>
        <UIcon name="i-lucide-chevron-right" class="ms-auto size-3.5 shrink-0 text-dimmed" :class="expanded ? 'rotate-90' : ''" aria-hidden="true" />
      </button>
    </ConsolePropertyRow>
    <div v-if="expanded" :id="`${inputId}-fields`" class="ms-3.5 grid border-s border-default ps-2">
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
        @submit="emit('submit')"
      />
    </div>
  </div>

  <ConsolePropertyRow
    v-else
    :icon="icon"
    :label="field.label"
    :description="field.description"
    :control="inputId"
    :error="error"
    :missing="missing && !error"
    @focusout="validate"
  >
    <UInput
      v-if="field.kind === 'string'"
      :id="inputId"
      v-model="text"
      class="w-full"
      variant="ghost"
      placeholder="Empty"
      :ui="{ base: ghost }"
      :disabled="disabled"
      :maxlength="field.maxLength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${inputId}-error` : undefined"
    />
    <UTextarea
      v-else-if="field.kind === 'text'"
      :id="inputId"
      v-model="text"
      class="w-full"
      variant="ghost"
      autoresize
      :rows="1"
      placeholder="Empty"
      :ui="{ base: `${ghost} leading-5` }"
      :disabled="disabled"
      :maxlength="field.maxLength"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error ? `${inputId}-error` : undefined"
      @keydown="onTextKeydown"
    />
    <UInputNumber
      v-else-if="field.kind === 'number' || field.kind === 'integer'"
      :id="inputId"
      v-model="number"
      class="w-full max-w-48"
      variant="ghost"
      placeholder="Empty"
      orientation="vertical"
      :ui="{ root: 'group/number', base: `${ghost} tabular-nums` }"
      :disabled="disabled"
      :min="field.minimum"
      :max="field.maximum"
      :step="field.kind === 'integer' ? 1 : 0.01"
      :increment="{ color: 'neutral', variant: 'link', size: 'xs', class: 'opacity-0 group-hover/number:opacity-100 group-focus-within/number:opacity-100' }"
      :decrement="{ color: 'neutral', variant: 'link', size: 'xs', class: 'opacity-0 group-hover/number:opacity-100 group-focus-within/number:opacity-100' }"
      :aria-invalid="error ? 'true' : undefined"
    />
    <div v-else-if="field.kind === 'boolean'" class="flex h-8 items-center px-2.5">
      <USwitch :id="inputId" v-model="boolean" size="sm" :disabled="disabled" />
    </div>
    <USelect
      v-else-if="field.kind === 'enum'"
      :id="inputId"
      v-model="enumValue"
      class="w-full max-w-64"
      variant="ghost"
      :items="enumItems"
      :ui="{ base: `${ghost} group/select`, trailingIcon: 'opacity-0 group-hover/select:opacity-75 group-focus-visible/select:opacity-75 group-data-[state=open]/select:opacity-75' }"
      :disabled="disabled"
      :placeholder="field.required ? 'Choose…' : 'None'"
      :aria-invalid="error ? 'true' : undefined"
    />
    <div v-else-if="field.kind === 'date' || field.kind === 'date-time'" class="flex min-w-0 flex-wrap items-center gap-x-1">
      <UInputDate
        :id="inputId"
        v-model="date"
        variant="ghost"
        :ui="{ base: `${ghost} gap-0`, segment }"
        :disabled="disabled"
        :aria-label="field.kind === 'date-time' ? `${field.label} date` : field.label"
        :aria-invalid="error ? 'true' : undefined"
      >
        <template #trailing>
          <UPopover v-model:open="calendarOpen" :content="{ align: 'start' }">
            <UButton variant="link" size="xs" icon="i-lucide-calendar" :aria-label="`Pick ${field.label.toLowerCase()} from a calendar`" class="px-0 text-dimmed hover:text-highlighted" :disabled="disabled" />
            <template #content>
              <UCalendar v-model="date" class="p-2" :ui="{ cellTrigger: 'tabular-nums' }" @update:model-value="calendarOpen = false" />
            </template>
          </UPopover>
        </template>
      </UInputDate>
      <template v-if="field.kind === 'date-time'">
        <UInputTime
          v-model="time"
          variant="ghost"
          :hour-cycle="24"
          :ui="{ base: `${ghost} gap-0`, segment }"
          :disabled="disabled || !date"
          :aria-label="`${field.label} time, UTC`"
        />
        <span class="text-xs text-dimmed">UTC</span>
      </template>
    </div>
    <UInputTags
      v-else-if="field.kind === 'string-list'"
      :id="inputId"
      v-model="list"
      class="w-full"
      variant="ghost"
      :ui="{ base: ghost, item: 'text-xs' }"
      :disabled="disabled"
      :placeholder="list.length ? (disabled ? undefined : 'Add…') : 'Empty'"
      :aria-invalid="error ? 'true' : undefined"
    />
    <ConsoleMediaField
      v-else-if="field.kind === 'blob'"
      v-model="model"
      :input-id="inputId"
      :kind="blob.kind"
      :accept="blob.accept"
      :label="field.label"
      :disabled="disabled"
    />
    <UTextarea
      v-else
      :id="inputId"
      :model-value="jsonText"
      class="w-full"
      variant="ghost"
      :ui="{ base: `${ghost} font-mono text-xs leading-5` }"
      autoresize
      :rows="1"
      :disabled="disabled"
      placeholder="JSON value"
      :aria-invalid="error ? 'true' : undefined"
      @update:model-value="updateJson(String($event ?? ''))"
      @keydown="onTextKeydown"
    />
  </ConsolePropertyRow>
</template>
