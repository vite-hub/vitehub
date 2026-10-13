/**
 * Section descriptors that the owner packages contribute. The playground serves them without a build.
 * `packages/vite-hub/test/console-contributions.test.ts` keeps them equal to the owner descriptors.
 */
export const playgroundConsoleContributions = [
  {
    description: "Inspect messages that the development outbox captured.",
    icon: "i-lucide-mail",
    id: "email",
    label: "Email",
    view: {
      columns: [
        { key: "subject", label: "Subject" },
        { key: "to", label: "To" },
        { key: "provider", label: "Provider" },
        { key: "delivery", label: "Delivery" },
        { key: "captured", label: "Captured" },
      ],
      kind: "record-table",
      notice: "Messages come from the in-memory development outbox of this server runtime on each request. The outbox exists only in `vite dev`, keeps the newest messages up to its limit, and a restart clears it. HTML is shown as escaped source and is never rendered. Use `vitehub email outbox show <id> --html` for the full source.",
    },
  },
  {
    description: "Inspect discovered Rate Limit policies and their source locations.",
    icon: "i-lucide-gauge",
    id: "rate-limits",
    label: "Rate Limits",
    view: {
      kind: "definition-catalog",
      notice: "Live counters and remaining quota are not included because their accuracy, scope, and availability depend on the provider.",
    },
  },
  {
    description: "Inspect discovered Sandbox Definitions without starting runtime resources.",
    icon: "i-lucide-container",
    id: "sandboxes",
    label: "Sandboxes",
    view: {
      kind: "definition-catalog",
      notice: "Running Sandboxes, files, processes, logs, ports, and lifecycle state are not included in this build-time catalog.",
    },
  },
  {
    description: "Inspect discovered Workspace Definitions and their source roots.",
    icon: "i-lucide-folder-kanban",
    id: "workspaces",
    label: "Workspaces",
    view: {
      kind: "definition-catalog",
      notice: "Workspace files, Sources, collections, sync state, and processes are not opened or initialized by this build-time catalog.",
    },
  },
  {
    description: "Inspect discovered Workflow Definitions and their source metadata.",
    icon: "i-ph-git-branch-light",
    id: "workflows",
    label: "Workflows",
    view: {
      kind: "definition-catalog",
      notice: "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
    },
  },
  {
    description: "Inspect discovered Queue Definitions and their source metadata.",
    icon: "i-ph-tray-light",
    id: "queues",
    label: "Queues",
    view: {
      kind: "definition-catalog",
      notice: "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
    },
  },
  {
    description: "Inspect Schedule Definitions, Runtime Schedules, and run history.",
    icon: "i-lucide-calendar-clock",
    id: "schedules",
    label: "Schedules",
    view: {
      columns: [
        { key: "kind", label: "Kind" },
        { key: "schedule", label: "Schedule" },
        { key: "target", label: "Target" },
        { key: "timing", label: "Cron" },
        { key: "enabled", label: "Enabled" },
        { key: "nextRun", label: "Next run" },
        { key: "lastRun", label: "Last run" },
      ],
      kind: "record-table",
      notice: "Runtime Schedules and runs come from the Schedule stores of this server runtime on each request. Memory stores lose data on restart. Schedules with `console.enabled: false` are hidden. The Console is read-only. Use `vitehub schedule run-runtime`, `enable`, or `disable` in development.",
    },
  },
] as const
