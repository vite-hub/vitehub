<script setup lang="ts">
import { CalendarDate, parseDate, Time } from "@internationalized/date";
import { computed, ref } from "vue";

/** The control of a schema form date field: a date, or a UTC date and time with `kind: "date-time"`. */
const props = defineProps<{
  disabled?: boolean;
  id: string;
  invalid?: boolean;
  kind: "date" | "date-time";
  label: string;
}>();

const model = defineModel<unknown>();

// Date and time segments size to their digits instead of fixed cells, so `9/1/2026 00:00` reads as one value.
const segment = "px-0.5 tabular-nums data-[segment=day]:w-auto data-[segment=month]:w-auto data-[segment=year]:w-auto data-[segment=hour]:w-auto data-[segment=minute]:w-auto data-[segment=literal]:px-0";

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
    model.value = props.kind === "date" ? day : `${day}T${(time.value ?? new Time(0, 0)).toString().slice(0, 5)}:00.000Z`;
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
</script>

<template>
  <div class="flex min-w-0 flex-wrap items-center gap-x-1">
    <UInputDate
      :id="id"
      v-model="date"
      variant="ghost"
      :ui="{ segment }"
      :highlight="Boolean(invalid)"
      :color="invalid ? 'error' : undefined"
      :disabled="disabled"
      :aria-label="kind === 'date-time' ? `${label} date` : label"
      :aria-invalid="invalid ? 'true' : undefined"
    >
      <template #trailing>
        <UPopover v-model:open="calendarOpen" :content="{ align: 'start' }">
          <UButton variant="ghost" size="xs" icon="i-lucide-calendar" :aria-label="`Pick ${label.toLowerCase()} from a calendar`" :disabled="disabled" />
          <template #content>
            <UCalendar v-model="date" class="p-2 tabular-nums" @update:model-value="calendarOpen = false" />
          </template>
        </UPopover>
      </template>
    </UInputDate>
    <template v-if="kind === 'date-time'">
      <UInputTime
        v-model="time"
        variant="ghost"
        :hour-cycle="24"
        :ui="{ segment }"
        :disabled="disabled || !date"
        :aria-label="`${label} time, UTC`"
      />
      <span class="text-xs text-dimmed">UTC</span>
    </template>
  </div>
</template>
