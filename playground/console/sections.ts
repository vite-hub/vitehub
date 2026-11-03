/**
 * Section descriptors that the owner packages contribute. The playground serves them without a build.
 * `packages/vite-hub/test/console-contributions.test.ts` keeps them equal to the owner descriptors.
 */
export const playgroundConsoleContributions = [
  {
    id: "auth",
    label: "Auth",
    icon: "i-vitehub-auth",
    description: "Manage users, sessions, organizations, and approved OAuth clients.",
    view: {
      kind: "auth-management",
      notice: "Better Auth owns user data and runs each change through its APIs.",
    },
  },
  {
    description: "Inspect messages that the development outbox captured.",
    icon: "i-vitehub-email",
    id: "email",
    label: "Email",
    view: {
      columns: [
        { key: "subject", label: "Subject" },
        { key: "to", label: "To" },
        { key: "provider", label: "Provider" },
        { filter: true, key: "delivery", label: "Delivery" },
        { key: "captured", label: "Captured" },
      ],
      kind: "record-table",
      notice: "Messages come from the in-memory development outbox of this server runtime on each request. The outbox exists only in `vite dev`, keeps the newest messages up to its limit, and a restart clears it. HTML is shown as escaped source and is never rendered. Use `vitehub email outbox show <id> --html` for the full source.",
    },
  },
  {
    description: "Inspect discovered Rate Limit policies and their source locations.",
    icon: "i-vitehub-rate-limit",
    id: "rate-limits",
    label: "Rate Limits",
    view: {
      kind: "definition-catalog",
      notice: "The page lists the policies. Enter a key to read its live counter or to reset it. Counters depend on the provider: a Cloudflare binding cannot be read or reset, and a memory counter exists only in this server process.",
    },
  },
  {
    description: "Inspect discovered Sandbox Task Definitions without starting runtime resources.",
    icon: "i-vitehub-sandbox",
    id: "sandbox-tasks",
    label: "Sandbox Tasks",
    view: {
      kind: "definition-catalog",
      notice: "Running Sandbox Tasks, files, processes, logs, ports, and lifecycle state are not included in this build-time catalog.",
    },
  },
  {
    description: "Inspect discovered Workspace Definitions and their source roots.",
    icon: "i-vitehub-workspace",
    id: "workspaces",
    label: "Workspaces",
    view: {
      kind: "definition-catalog",
      notice: "Workspace files, Sources, collections, sync state, and processes are not opened or initialized by this build-time catalog.",
    },
  },
  {
    description: "Inspect discovered Workflow Definitions and their source metadata.",
    icon: "i-vitehub-workflow",
    id: "workflows",
    label: "Workflows",
    view: {
      kind: "definition-catalog",
      notice: "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
    },
  },
  {
    description: "Inspect discovered Queue Definitions and their source metadata.",
    icon: "i-vitehub-queue",
    id: "queues",
    label: "Queues",
    view: {
      kind: "definition-catalog",
      notice: "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
    },
  },
  {
    description: "Inspect Schedule Definitions.",
    icon: "i-vitehub-schedule",
    id: "schedules",
    label: "Schedules",
    view: {
      columns: [
        { key: "schedule", label: "Schedule" },
        { key: "timing", label: "Cron" },
        { key: "manual", label: "Manual" },
      ],
      kind: "record-table",
      notice: "The host runs each Schedule on its cron, in its time zone (UTC by default). Definitions with `manual: true` can also run from the Console or `vitehub schedule run`.",
    },
  },
] as const

/**
 * The Comments section of an app with a default-export `server/comments.ts`. The build puts it in place of the Comments
 * record table, so it is not in the list above. `packages/vite-hub/test/console-contributions.test.ts` keeps it equal to
 * `commentsOperationsConsoleSection`. `comments.ts` answers its operations.
 */
export const playgroundCommentsSection = {
  description: "Read the comment threads of the site and jump to the page.",
  icon: "i-vitehub-comments",
  id: "comments",
  label: "Comments",
  view: {
    columns: [
      { key: "n", label: "#" },
      { key: "subject.id", label: "Subject" },
      { key: "status", label: "Status" },
      { key: "author.name|author.id", label: "Author" },
      { key: "messages.0.body", label: "Comment", format: "excerpt" },
      { key: "updatedAt", label: "Updated", format: "datetime" },
    ],
    detail: { kind: "comment-thread" },
    filters: [
      { id: "all", input: {}, label: "All" },
      { id: "open", input: { status: "open" }, label: "Open" },
      { id: "resolved", input: { status: "resolved" }, label: "Resolved" },
      { id: "mine", input: { mine: true }, label: "Mine" },
      { id: "mentions", input: { mentions: true }, label: "Mentions" },
    ],
    kind: "operation-view",
    link: { label: "Open page", template: "{subject.id:path}?comment={n}", when: { equals: "page", path: "subject.kind" } },
    notice: "The list comes from the comments.list operation with your sign-in, so it shows only the threads that authorize lets you read. Without an authorize policy nobody can read comments: add one to defineComments(). `vitehub comments list` lists the same threads.",
    operation: "comments.list",
    pagination: { limit: 200, cursor: { id: "id", updatedAt: "updatedAt" } },
  },
} as const
