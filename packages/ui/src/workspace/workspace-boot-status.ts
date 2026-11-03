import type { WebContainerStage, WebContainerStep } from "@vite-hub/web-container";
import { computed, defineComponent, h, onBeforeUnmount, type PropType, ref, watch } from "vue";
import { icon } from "./icons.ts";
import type { WorkspaceFailure, WorkspaceStatus } from "./use-workspace.ts";

type ChecklistStage = Extract<WebContainerStage, "checking" | "booting" | "mounting" | "installing" | "starting">;
export type BootStepState = "pending" | "running" | "done" | "failed" | "skipped";

const checklist: readonly { stage: ChecklistStage, label: string }[] = [
  { label: "Check browser support", stage: "checking" },
  { label: "Start WebContainer", stage: "booting" },
  { label: "Load project files", stage: "mounting" },
  { label: "Install dependencies", stage: "installing" },
  { label: "Start dev server", stage: "starting" },
];

/** The install hint shows after this many milliseconds. */
const slowInstallMs = 20_000;

export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
}

export interface BootStepView {
  stage: ChecklistStage
  label: string
  state: BootStepState
  /** Milliseconds so far. Unset for a step that did not start. */
  ms?: number
}

/** Maps the steps of `@vite-hub/web-container` to the five rows of the checklist. */
export function bootChecklist(steps: readonly WebContainerStep[], status: WorkspaceStatus, now: number): BootStepView[] {
  const failed = status === "error" || status === "unsupported";
  const last = [...steps].reverse().find(step => step.stage !== "error" && step.stage !== "unsupported" && step.stage !== "ready");
  const reached = last ? checklist.findIndex(row => row.stage === last.stage) : -1;
  return checklist.map((row, index) => {
    const step = [...steps].reverse().find(candidate => candidate.stage === row.stage);
    if (!step) return { ...row, state: index < reached ? "skipped" : "pending" };
    const ms = step.ms ?? Math.max(0, now - step.startedAt);
    if (failed && step === last) return { ...row, ms, state: "failed" };
    return { ...row, ms, state: step.ms === undefined ? "running" : "done" };
  });
}

const stateIcon = {
  done: () => icon("check", "vh-ws-icon vh-ws-step-icon"),
  failed: () => icon("circle-alert", "vh-ws-icon vh-ws-step-icon"),
  pending: () => h("span", { "aria-hidden": "true", class: "vh-ws-step-dot" }),
  running: () => h("span", { "aria-hidden": "true", class: "vh-ws-step-dot is-running" }),
  skipped: () => h("span", { "aria-hidden": "true", class: "vh-ws-step-dot" }),
};

const stateText: Record<BootStepState, string> = {
  done: "Done",
  failed: "Failed",
  pending: "Waiting",
  running: "Running",
  skipped: "Skipped",
};

function failureCopy(failure: WorkspaceFailure): { title: string, body: string } {
  switch (failure.kind) {
    case "install":
      return { body: `npm install exited with code ${failure.exitCode}. The output shows which package failed.`, title: "Install failed" };
    case "server":
      return { body: `The dev server exited with code ${failure.exitCode}. Your edits are kept.`, title: "The dev server stopped" };
    case "unsupported":
      return { body: failure.error.message, title: "The live workspace does not run here" };
    case "boot":
      return { body: failure.error.message, title: "The workspace did not start" };
  }
}

/**
 * A checklist of the boot stages with live elapsed times. It shows no progress bar,
 * because an install has no reliable total.
 */
export const WorkspaceBootStatus = defineComponent({
  name: "WorkspaceBootStatus",
  props: {
    status: { required: true, type: String as PropType<WorkspaceStatus> },
    steps: { default: () => [], type: Array as PropType<readonly WebContainerStep[]> },
    failure: { default: undefined, type: Object as PropType<WorkspaceFailure> },
    online: { default: true, type: Boolean },
  },
  emits: {
    /** Boot again after `failure.kind` is `boot`. */
    retry: () => true,
    /** Run the install again after `failure.kind` is `install`. */
    "retry-install": () => true,
    /** Start the dev server again after `failure.kind` is `server`. */
    restart: () => true,
    /** Show the terminal output. */
    "show-output": () => true,
  },
  setup(props, { emit }) {
    const now = ref(typeof performance === "undefined" ? 0 : performance.now());
    let timer: ReturnType<typeof setInterval> | undefined;
    const rows = computed(() => bootChecklist(props.steps, props.status, now.value));
    const running = computed(() => rows.value.find(row => row.state === "running"));

    watch(running, (row) => {
      if (row && !timer) timer = setInterval(() => { now.value = performance.now(); }, 100);
      if (!row && timer) {
        clearInterval(timer);
        timer = undefined;
        now.value = performance.now();
      }
    }, { immediate: true });
    onBeforeUnmount(() => { if (timer) clearInterval(timer); });

    const showOutput = () => h("button", { class: "vh-ws-button", type: "button", onClick: () => emit("show-output") }, "Show output");

    return () => {
      const slowInstall = running.value?.stage === "installing" && (running.value.ms ?? 0) > slowInstallMs;
      const failure = props.failure;
      const ready = props.status === "ready" && !failure;
      const heading = failure ? failureCopy(failure).title : ready ? "The workspace is ready" : "Starting the workspace";
      return h("div", { "aria-busy": running.value ? "true" : "false", class: "vh-ws-boot", "data-status": props.status }, [
        h("p", { class: "vh-ws-boot-title", role: "status" }, heading),
        h("ol", { "aria-label": "Workspace start steps", class: "vh-ws-steps" }, rows.value.map(row => h("li", {
          class: "vh-ws-step",
          "data-stage": row.stage,
          "data-state": row.state,
          key: row.stage,
        }, [
          stateIcon[row.state](),
          h("span", { class: "vh-ws-step-label" }, row.label),
          h("span", { class: "vh-ws-sr-only" }, `, ${stateText[row.state]}`),
          h("span", { class: "vh-ws-step-time" }, row.ms === undefined ? "" : formatElapsed(row.ms)),
        ]))),
        slowInstall ? h("p", { class: "vh-ws-muted vh-ws-boot-hint" }, "First install downloads packages. Later steps reuse them.") : undefined,
        props.online ? undefined : h("p", { class: "vh-ws-notice", role: "alert" }, [
          icon("wifi-off"),
          h("span", "You are offline. Installing packages needs a connection. Your edits are kept."),
        ]),
        failure ? h("div", { class: "vh-ws-failure", role: "alert" }, [
          h("p", { class: "vh-ws-failure-body" }, failureCopy(failure).body),
          h("div", { class: "vh-ws-actions" }, failure.kind === "install"
            ? [h("button", { class: "vh-ws-button vh-ws-button--primary", type: "button", onClick: () => emit("retry-install") }, "Retry install"), showOutput()]
            : failure.kind === "server"
              ? [h("button", { class: "vh-ws-button vh-ws-button--primary", type: "button", onClick: () => emit("restart") }, "Restart server"), showOutput()]
              : failure.kind === "boot"
                ? [h("button", { class: "vh-ws-button vh-ws-button--primary", type: "button", onClick: () => emit("retry") }, "Try again"), showOutput()]
                : []),
        ]) : h("div", { class: "vh-ws-actions" }, [showOutput()]),
      ]);
    };
  },
});
