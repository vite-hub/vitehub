<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { cancelConsoleWorkflow, isConsoleWorkflowRunActive, parseConsoleWorkflowPayload, readConsoleWorkflow, resumeConsoleWorkflow, startConsoleWorkflow } from "../client/workflow";
import type { ConsoleWorkflowRunView } from "../client/workflow";
import { consoleStatusValue } from "../client/format";
import { useConsoleToast } from "../client/toast";
import ConsoleStatus from "./console-status.vue";

const props = defineProps<{
  /** Console route that runs the `workflow.*` operations. */
  base: string;
  /** `workflow.resume` is registered for this access. Without it the page hides Resume. */
  canResume: boolean;
  /** `workflow.start` is registered for this access. Without it the page hides Start. */
  canStart: boolean;
  /** Name of the selected Workflow Definition. */
  workflow: string;
}>();

const toast = useConsoleToast();
const payloadText = ref("");
const starting = ref(false);
const startError = ref<string>();
const runs = ref<ConsoleWorkflowRunView[]>([]);
const busyRun = ref<string>();
const cancelTarget = ref<ConsoleWorkflowRunView>();
const signalToken = ref("");
const signalPayload = ref("");
const resuming = ref(false);
const resumeError = ref<string>();

const workflowRuns = computed(() => runs.value.filter((run) => run.workflow === props.workflow));

watch(() => props.workflow, () => {
  startError.value = undefined;
});

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusOf(run: ConsoleWorkflowRunView): { label: string; pending?: boolean; tone: "error" | "neutral" | "success" | "warning" } {
  const status = consoleStatusValue(run.status);
  return { label: status?.label ?? run.status, tone: status?.tone ?? "neutral", ...(status?.pending ? { pending: true } : {}) };
}

function replaceRun(next: ConsoleWorkflowRunView): void {
  runs.value = [next, ...runs.value.filter((run) => !(run.id === next.id && run.workflow === next.workflow))];
}

async function copy(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.show({ title: `${label} copied` });
  } catch {
    toast.error(`Couldn't copy the ${label.toLowerCase()}.`);
  }
}

async function start(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  startError.value = undefined;
  try {
    const run = await startConsoleWorkflow(props.base, props.workflow, parseConsoleWorkflowPayload(payloadText.value));
    replaceRun(run);
    toast.show({ title: "Run started" });
  } catch (error) {
    startError.value = message(error, "The Console could not start this Workflow.");
  } finally {
    starting.value = false;
  }
}

async function refresh(run: ConsoleWorkflowRunView): Promise<void> {
  if (busyRun.value) return;
  busyRun.value = run.id;
  try {
    replaceRun(await readConsoleWorkflow(props.base, run));
  } catch (error) {
    toast.error(message(error, "The Console could not read this run."));
  } finally {
    busyRun.value = undefined;
  }
}

async function confirmCancel(): Promise<void> {
  const run = cancelTarget.value;
  if (!run || busyRun.value) return;
  busyRun.value = run.id;
  try {
    replaceRun(await cancelConsoleWorkflow(props.base, run));
    toast.show({ title: "Run cancelled" });
  } catch (error) {
    toast.error(message(error, "The Console could not cancel this run."));
  } finally {
    cancelTarget.value = undefined;
    busyRun.value = undefined;
  }
}

async function resume(): Promise<void> {
  if (resuming.value || !signalToken.value.trim()) return;
  resuming.value = true;
  resumeError.value = undefined;
  try {
    await resumeConsoleWorkflow(props.base, signalToken.value.trim(), parseConsoleWorkflowPayload(signalPayload.value));
    toast.show({ title: "Signal delivered" });
    signalToken.value = "";
    signalPayload.value = "";
  } catch (error) {
    resumeError.value = message(error, "The Console could not resume this signal.");
  } finally {
    resuming.value = false;
  }
}
</script>

<template>
  <div v-if="canStart || canResume || workflowRuns.length" class="grid gap-6">
    <section v-if="canStart" class="grid gap-2" aria-label="Start a run">
      <h3 class="text-xs font-medium text-highlighted">Start a run</h3>
      <UTextarea v-model="payloadText" :rows="5" :ui="{ base: 'font-mono text-xs' }" aria-label="Payload (JSON)" placeholder="Payload as JSON. Leave empty to start without one." />
      <p v-if="startError" class="text-xs text-error" role="alert">{{ startError }}</p>
      <div class="flex justify-end">
        <UButton icon="i-lucide-play" label="Start" size="sm" :loading="starting" @click="start" />
      </div>
    </section>

    <section v-if="workflowRuns.length" class="grid gap-2" aria-label="Runs started here">
      <h3 class="text-xs font-medium text-highlighted">Runs started here</h3>
      <ul class="divide-y divide-default border-y border-default">
        <li v-for="run in workflowRuns" :key="run.id" class="grid gap-2 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate font-mono text-xs text-highlighted" :title="run.id">{{ run.id }}</span>
            <UTooltip text="Copy run ID">
              <UButton class="-ms-1 me-auto" aria-label="Copy run ID" color="neutral" icon="i-lucide-copy" size="xs" variant="ghost" @click="copy(run.id, 'Run ID')" />
            </UTooltip>
            <ConsoleStatus :label="statusOf(run).label" :tone="statusOf(run).tone" :pending="statusOf(run).pending" />
            <UTooltip text="Refresh">
              <UButton aria-label="Refresh run" icon="i-lucide-refresh-cw" size="xs" variant="ghost" :loading="busyRun === run.id" @click="refresh(run)" />
            </UTooltip>
            <UTooltip v-if="isConsoleWorkflowRunActive(run.status)" text="Cancel run">
              <UButton aria-label="Cancel run" color="error" icon="i-lucide-square" size="xs" variant="ghost" :disabled="Boolean(busyRun)" @click="cancelTarget = run" />
            </UTooltip>
          </div>
          <p v-if="run.error" class="text-xs text-error">{{ run.error }}</p>
          <div v-if="run.result" class="relative">
            <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-elevated p-3 pe-10 font-mono text-xs leading-5 text-toned"><code>{{ run.result }}</code></pre>
            <UTooltip text="Copy result">
              <UButton class="absolute end-1.5 top-1.5" aria-label="Copy result" color="neutral" icon="i-lucide-copy" size="xs" variant="ghost" @click="copy(run.result, 'Result')" />
            </UTooltip>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="canResume" class="grid gap-2" aria-label="Resume a signal">
      <h3 class="text-xs font-medium text-highlighted">Resume a signal</h3>
      <UInput v-model="signalToken" aria-label="Signal token" placeholder="Opaque signal token" :ui="{ base: 'font-mono text-xs' }" />
      <UTextarea v-model="signalPayload" :rows="3" :ui="{ base: 'font-mono text-xs' }" aria-label="Signal payload (JSON)" placeholder="Payload as JSON. Optional." />
      <p v-if="resumeError" class="text-xs text-error" role="alert">{{ resumeError }}</p>
      <div class="flex justify-end">
        <UButton icon="i-lucide-corner-down-right" label="Resume" size="sm" variant="outline" :disabled="!signalToken.trim()" :loading="resuming" @click="resume" />
      </div>
    </section>

    <UModal :open="Boolean(cancelTarget)" title="Cancel this run?" :ui="{ content: 'sm:max-w-[440px]' }" @update:open="(open: boolean) => { if (!open) cancelTarget = undefined }">
      <template #body>
        <p class="text-[13px] text-muted">
          <span class="font-mono text-xs text-highlighted">{{ cancelTarget?.id }}</span> stops. Only providers that support cancellation accept this.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" label="Keep running" @click="cancelTarget = undefined" />
          <UButton color="error" label="Cancel run" :loading="Boolean(busyRun)" @click="confirmCancel" />
        </div>
      </template>
    </UModal>
  </div>
</template>
