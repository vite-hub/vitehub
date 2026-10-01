/**
 * Section descriptors that the Workflow and Queue owner packages contribute. The playground serves them without a build.
 * `packages/vite-hub/test/console-contributions.test.ts` keeps them equal to the owner descriptors.
 */
export const playgroundConsoleContributions = [
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
] as const
