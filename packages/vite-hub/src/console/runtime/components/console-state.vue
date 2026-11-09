<script setup lang="ts">
import type { ButtonProps } from "@nuxt/ui";
import { CopyButton } from "@vite-hub/ui";
import { computed } from "vue";

import { consoleProblem } from "../client/problem";
import { consoleSignInURL } from "../client/sign-in";
import { consolePrimitives } from "../sections";

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
    // The sign-in page brings the person back to this page. Without one, the page reloads, which lets Cloudflare Access sign them in.
    const signIn = consoleSignInURL({ document, location: window.location });
    main.push(signIn ? { label: "Sign in again", icon: "i-lucide-log-in", to: signIn, external: true } : { label: "Sign in again", icon: "i-lucide-log-in", onClick: reload });
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
  <!-- Compact: an inline alert for sidebars and panels. The icon has its own column; everything else starts on one edge. -->
  <div
    v-if="compact"
    :role="problem ? 'alert' : 'status'"
    class="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-md bg-elevated/50 px-3 py-2.5 text-xs"
  >
    <UIcon :name="stateIcon" class="mt-0.5 size-4 text-muted" />
    <div class="grid min-w-0 gap-1">
      <h2 class="text-[13px] font-medium leading-5 text-highlighted">{{ title }}</h2>
      <p v-if="problem?.why || description" class="leading-5 text-pretty text-muted">{{ problem?.why ?? description }}</p>
      <p v-if="fix" class="leading-5 text-pretty text-default">{{ fix }}</p>
      <slot />
      <div v-if="stateActions.length" class="mt-1 flex flex-wrap items-center gap-1">
        <UButton v-for="(button, index) in stateActions" :key="index" v-bind="button" />
      </div>
      <UTooltip v-if="problem" text="Copy error code">
        <CopyButton
          :value="problem.code"
          size="xs"
          class="-mx-2 max-w-full justify-self-start text-start font-mono text-dimmed [overflow-wrap:anywhere]"
          :aria-label="`Copy error code ${problem.code}`"
        >
          {{ problem.code }} <span v-if="problem.status" class="whitespace-nowrap">· {{ problem.status }}</span>
        </CopyButton>
      </UTooltip>
    </div>
  </div>
  <UEmpty
    v-else
    :role="problem ? 'alert' : 'status'"
    :icon="stateIcon"
    :title="title"
    variant="naked"
    class="min-h-0 flex-1"
  >
    <template v-if="problem?.why || description || fix" #description>
      <p v-if="problem?.why || description" class="text-pretty">{{ problem?.why ?? description }}</p>
      <p v-if="fix" class="text-pretty text-default">{{ fix }}</p>
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
