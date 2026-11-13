<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";
import { CopyButton } from "@vite-hub/ui";
import { computed } from "vue";

import { consoleProblem } from "../client/problem";
import { consolePrimitives } from "../sections";
import ConsoleCodeText from "./console-code-text.vue";

/**
 * One Console state: an error, an empty list, or a primitive that is not configured.
 * - With `error`, it shows the why, the fix, the code, and one next step. A retry button appears only when `retry`
 *   is set and a retry can succeed. `401` asks to sign in again. A fix that only repeats the main button is left out.
 * - Without `error`, it shows `title` and `description`, and links the setup guide of `section`.
 * A full state grows to fill its parent and centers in it. Put it in a flex column, such as the pane's scroll container
 * with `flex flex-col`, or it stays at the top of the pane.
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
  if (problem.value?.action === "sign-in") return "i-lucide-log-in";
  if (problem.value?.status === 403) return "i-lucide-lock";
  if (problem.value) return "i-lucide-cloud-off";
  return props.icon ?? "i-lucide-inbox";
});

// A compact state takes the color of its status: red for a failure, amber for access that the person must fix by
// signing in or asking for a role, and neutral for an empty or unconfigured state.
const alertColor = computed(() => {
  if (!problem.value) return "neutral";
  return problem.value.action === "sign-in" || problem.value.status === 401 || problem.value.status === 403 ? "warning" : "error";
});

function reload(): void {
  window.location.reload();
}

const docsAction = computed<ButtonProps | undefined>(() =>
  docsURL.value
    ? {
        // A compact state sits in a narrow sidebar, so its docs link stays short enough to share a row.
        label: problem.value ? (props.compact ? "Docs" : "Read the docs") : "Get started",
        to: docsURL.value,
        target: "_blank",
        trailingIcon: "i-lucide-arrow-up-right",
      }
    : undefined,
);

const stateActions = computed<ButtonProps[]>(() => {
  const main: ButtonProps[] = [];
  const action = problem.value?.action;
  if (action === "sign-in") {
    main.push({ label: "Sign in again", icon: "i-lucide-log-in", onClick: reload });
  }
  else if (action === "reload") main.push({ label: "Reload", icon: "i-lucide-refresh-cw", onClick: reload });
  else if (action === "retry" && props.retry) main.push({ label: "Try again", icon: "i-lucide-refresh-cw", onClick: () => void props.retry?.() });
  // A full state replaces the page, so its first button is the main action of the view. A compact state sits beside
  // other content, so its first button is an outline button. Later buttons are ghost buttons.
  const lead: ButtonProps = props.compact ? { variant: "outline", size: "xs" } : {};
  const rest: ButtonProps = props.compact ? { variant: "ghost", size: "xs" } : { variant: "ghost" };
  const first = main[0];
  const buttons: ButtonProps[] = first ? [{ ...lead, ...first }] : [];
  if (docsAction.value) buttons.push({ ...(buttons.length ? rest : lead), ...docsAction.value });
  for (const extra of props.actions ?? []) buttons.push({ ...rest, ...extra });
  return buttons;
});

// A fix that only names the main button, such as "Sign in again.", says the same thing twice. The button says it once.
const fix = computed(() => {
  const text = problem.value?.fix;
  return text && text.replace(/\.$/, "") === stateActions.value[0]?.label ? undefined : text;
});
</script>

<template>
  <!-- Compact: an inline alert for sidebars and panels. -->
  <UAlert
    v-if="compact"
    :role="problem ? 'alert' : 'status'"
    :icon="stateIcon"
    :title="title"
    :color="alertColor"
  >
    <template v-if="problem?.why || description || fix || $slots.default" #description>
      <p v-if="problem?.why || description" class="text-pretty"><ConsoleCodeText :text="problem?.why ?? description ?? ''" /></p>
      <p v-if="fix" class="text-pretty"><ConsoleCodeText :text="fix" /></p>
      <slot />
    </template>
    <template v-if="stateActions.length || problem" #actions>
      <UButton v-for="(button, index) in stateActions" :key="index" v-bind="button" />
      <UTooltip v-if="problem" text="Copy error code">
        <CopyButton
          :value="problem.code"
          size="xs"
          class="max-w-full text-start font-mono [overflow-wrap:anywhere]"
          :aria-label="`Copy error code ${problem.code}`"
        >
          {{ problem.code }} <span v-if="problem.status" class="whitespace-nowrap">· {{ problem.status }}</span>
        </CopyButton>
      </UTooltip>
    </template>
  </UAlert>
  <UEmpty
    v-else
    :role="problem ? 'alert' : 'status'"
    :icon="stateIcon"
    :title="title"
    variant="naked"
    class="min-h-0 flex-1"
  >
    <template v-if="problem?.why || description || fix" #description>
      <p v-if="problem?.why || description" class="text-pretty"><ConsoleCodeText :text="problem?.why ?? description ?? ''" /></p>
      <p v-if="fix" class="text-pretty text-default"><ConsoleCodeText :text="fix" /></p>
    </template>
    <template #body>
      <!-- Extra content for the state, such as a code example for an empty state. -->
      <slot />
      <div v-if="stateActions.length || problem" class="flex flex-wrap items-center justify-center gap-1">
        <UButton v-for="(button, index) in stateActions" :key="index" v-bind="button" />
        <UTooltip v-if="problem" text="Copy error code">
          <CopyButton :value="problem.code" class="font-mono text-dimmed" :aria-label="`Copy error code ${problem.code}`">
            {{ problem.code }}<span v-if="problem.status"> · {{ problem.status }}</span>
          </CopyButton>
        </UTooltip>
      </div>
    </template>
  </UEmpty>
</template>
