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

interface PendingTemplate extends ExampleBase {
  kind: "template";
  status: "pending";
  action: {
    kind: "use";
    label: "Template unavailable";
  };
  publicationNote: string;
  startPath: string;
}

interface PublishedTemplate extends ExampleBase {
  kind: "template";
  status: "published";
  action: {
    kind: "use";
    label: "Use template";
    to: string;
  };
  startPath: string;
}

export type Example = PendingProject | PublishedProject | PendingTemplate | PublishedTemplate;

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
    slug: "nuxt-agent",
    name: "Nuxt Agent",
    description:
      "A ViteHub Agent that answers Nuxt questions through Telegram text and voice using Nuxt's MCP server and public documentation.",
    builtWith: ["Agent Definitions", "MCP", "Workspaces", "Channels", "Rate Limit", "Workflow"],
    kind: "template",
    status: "pending",
    action: {
      kind: "use",
      label: "Template unavailable",
    },
    publicationNote:
      "Pending an explicit license and Node 24 support for local and Vercel runtimes.",
    startPath: "server/agents/nuxt/agent.ts",
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
