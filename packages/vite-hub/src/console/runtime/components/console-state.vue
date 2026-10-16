<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";
import { computed, onBeforeUnmount, ref } from "vue";

import { consoleProblem } from "../client/problem";
import { consolePrimitives } from "../sections";

/**
 * One Console state: an error, an empty list, or a primitive that is not configured.
 * - With `error`, it shows the why, the fix, the code, and one next step. A retry button appears only when `retry`
 *   is set and a retry can succeed. `401` asks to sign in again.
 * - Without `error`, it shows `title` and `description`, and links the setup guide of `section`.
 */
const props = withDefaults(
  defineProps<{
    /** Extra buttons, such as "Clear filters". They come after the main action. */
    actions?: ButtonProps[];
    /** An inline alert for sidebars and detail panels instead of a centered state. */
    compact?: boolean;
    description?: string;
    /** A docs link for an empty state. Defaults to the setup guide of `section`. */
    docs?: string;
    error?: unknown;
    icon?: string;
    retry?: () => unknown;
    /** The Console section. An empty state links its setup guide. */
    section?: string;
    title: string;
  }>(),
  { actions: undefined, compact: false, description: undefined, docs: undefined, error: undefined, icon: undefined, retry: undefined, section: undefined },
);

const problem = computed(() => consoleProblem(props.error));
const primitive = computed(() => consolePrimitives.find((entry) => entry.id === props.section));
const docsURL = computed(() => problem.value ? problem.value.docs : props.docs ?? primitive.value?.setup);
const stateIcon = computed(() => {
  if (props.icon && !problem.value) return props.icon;
  if (problem.value?.action === "sign-in") return "i-ph-sign-in-light";
  if (problem.value?.status === 403) return "i-ph-lock-simple-light";
  if (problem.value) return "i-ph-cloud-slash-light";
  return props.icon ?? "i-ph-tray-light";
});

function reload(): void {
  window.location.reload();
}

const docsAction = computed<ButtonProps | undefined>(() =>
  docsURL.value
    ? {
        label: problem.value ? "Read the docs" : "Get started",
        to: docsURL.value,
        target: "_blank",
        trailingIcon: "i-ph-arrow-up-right-light",
      }
    : undefined,
);

const stateActions = computed<ButtonProps[]>(() => {
  const main: ButtonProps[] = [];
  const action = problem.value?.action;
  if (action === "sign-in") main.push({ label: "Sign in again", icon: "i-ph-sign-in-light", onClick: reload });
  else if (action === "reload") main.push({ label: "Reload", icon: "i-ph-arrows-clockwise-light", onClick: reload });
  else if (action === "retry" && props.retry) main.push({ label: "Try again", icon: "i-ph-arrows-clockwise-light", onClick: () => void props.retry?.() });
  const first = main[0];
  const buttons: ButtonProps[] = first ? [{ color: "neutral", variant: "soft", size: "xs", ...first }] : [];
  if (docsAction.value) {
    buttons.push({ color: "neutral", variant: buttons.length ? "link" : "soft", size: "xs", ...docsAction.value });
  }
  for (const extra of props.actions ?? []) buttons.push({ color: "neutral", variant: "link", size: "xs", ...extra });
  return buttons;
});

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCode(): Promise<void> {
  if (!problem.value) return;
  try {
    await navigator.clipboard.writeText(problem.value.code);
    copied.value = true;
  } catch {
    copied.value = false;
    return;
  }
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 2_000);
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <div
    :role="problem ? 'alert' : 'status'"
    :class="
      compact
        ? 'grid gap-1.5 rounded-md bg-elevated/50 px-3 py-2.5 text-xs'
        : 'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center'
    "
  >
    <div :class="compact ? 'flex items-start gap-2' : 'grid justify-items-center gap-2'">
      <UIcon :name="stateIcon" :class="compact ? 'mt-px size-4 shrink-0 text-muted' : 'size-5 text-muted'" />
      <div :class="compact ? 'min-w-0 flex-1' : 'grid max-w-sm gap-1'">
        <h2 class="text-sm font-medium text-highlighted">{{ title }}</h2>
        <p v-if="problem?.why || description" class="text-xs leading-5 text-muted">
          {{ problem?.why ?? description }}
        </p>
        <p v-if="problem?.fix" class="text-xs leading-5 text-default">{{ problem.fix }}</p>
      </div>
    </div>
    <div
      v-if="stateActions.length || problem"
      :class="compact ? 'flex flex-wrap items-center gap-x-1 gap-y-1 ps-6' : 'flex flex-wrap items-center justify-center gap-1'"
    >
      <UButton v-for="(button, index) in stateActions" :key="index" v-bind="button" />
      <UTooltip v-if="problem" :text="copied ? 'Copied' : 'Copy error code'">
        <button
          type="button"
          class="ms-1 rounded px-1 font-mono text-[11px] text-dimmed outline-none hover:text-muted focus-visible:ring-1 focus-visible:ring-primary"
          :aria-label="`Copy error code ${problem.code}`"
          @click="copyCode"
        >
          {{ problem.code }}<span v-if="problem.status"> · {{ problem.status }}</span>
        </button>
      </UTooltip>
    </div>
  </div>
</template>
