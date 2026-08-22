interface ExampleBase {
  slug: string;
  name: string;
  description: string;
  builtWith: readonly string[];
}

interface PendingProject extends ExampleBase {
  kind: "project";
  status: "pending";
  action: {
    kind: "source";
    label: "Source unavailable";
  };
  publicationNote: string;
}

interface PublishedProject extends ExampleBase {
  kind: "project";
  status: "published";
  action: {
    kind: "source";
    label: "View source";
    to: string;
  };
}

interface Template extends ExampleBase {
  kind: "template";
  status: "published";
  action: {
    kind: "use";
    label: "Use template";
    to: string;
  };
  startPath: string;
}

export type Example = PendingProject | PublishedProject | Template;

export const examples: readonly Example[] = [
  {
    slug: "drop",
    name: "Drop",
    description:
      "Permanent URLs for agent-uploaded files and temporary rendered code images, built with ViteHub primitives.",
    builtWith: ["Blob", "Queue", "Rate Limit", "Sandbox", "Schedule"],
    kind: "project",
    status: "published",
    action: {
      kind: "source",
      label: "View source",
      to: "https://github.com/vite-hub/drop",
    },
  },
  {
    slug: "calories",
    name: "Calories",
    description:
      "A starter template for experimenting with a ViteHub Agent. Send a meal by text, photo, or voice; the Agent estimates calories and protein, saves the meal, and shows it in a Nuxt dashboard.",
    builtWith: ["Agent Definitions", "Channels", "Database", "Blob"],
    kind: "template",
    status: "published",
    action: {
      kind: "use",
      label: "Use template",
      to: "https://github.com/vite-hub/calories/generate",
    },
    startPath: "server/agents/calories/agent.ts",
  },
  {
    slug: "my-pull-requests",
    name: "My Pull Requests",
    description:
      "A public dashboard for recent open source contributions, plus a shareable GitHub recap generated every month.",
    builtWith: ["Sources", "Collections", "Schedule", "Workflow", "KV", "Email"],
    kind: "template",
    status: "published",
    action: {
      kind: "use",
      label: "Use template",
      to: "https://github.com/vite-hub/my-pull-requests/generate",
    },
    startPath: "app/pages/index.vue",
  },
  {
    slug: "babysitter",
    name: "Babysitter",
    description:
      "A ViteHub Agent and Schedule that owns pull requests from trusted-host worktrees.",
    builtWith: ["Agent Definitions", "Schedule"],
    kind: "project",
    status: "pending",
    action: {
      kind: "source",
      label: "Source unavailable",
    },
    publicationNote: "Pending anonymous repository access and an explicit license.",
  },
];
