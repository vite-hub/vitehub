interface ExampleBase {
  slug: string;
  name: string;
  description: string;
  builtWith: readonly string[];
  website?: string;
}

export type ExamplePreview =
  | { kind: "mockup"; app: "drop" | "calories"; alt: string }
  | { kind: "screenshot"; src: string; alt: string; source: string };

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
  preview: ExamplePreview;
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
  preview: ExamplePreview;
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
      "Review documents and small apps created by your Agent. Comment on a specific passage, share a private review link, and let the Agent use your feedback in its next version.",
    builtWith: ["Auth", "Database", "Blob", "KV", "Rate Limit", "Browser", "Schedule"],
    website: "https://drop.vitehub.dev",
    kind: "project",
    status: "published",
    preview: {
      kind: "mockup",
      app: "drop",
      alt: "App mockup of a document review in Drop, with a highlighted passage and a reviewer comment.",
    },
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
      "Send a meal to a Telegram Agent as text, a photo, or a voice note. It estimates calories and protein, saves the meal, and updates a Nuxt meal journal. Estimates are experimental and can be inaccurate.",
    builtWith: ["Agent Definitions", "Channels", "Database", "Blob"],
    kind: "template",
    status: "published",
    preview: {
      kind: "mockup",
      app: "calories",
      alt: "App mockup of the Calories meal journal with sample calorie totals, protein totals, and saved meals.",
    },
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
      "Browse your public GitHub pull requests and issues in one dashboard. A scheduled Workflow builds a monthly recap, stores it in KV, and sends it by email.",
    builtWith: ["Sources", "Collections", "Schedule", "Workflow", "KV", "Email"],
    kind: "template",
    status: "published",
    website: "https://prs.onmax.me",
    preview: {
      kind: "screenshot",
      src: "/examples/my-pull-requests.jpg",
      alt: "My Pull Requests app showing contribution totals and a list of recent GitHub pull requests.",
      source: "https://github.com/vite-hub/my-pull-requests/blob/main/.github/assets/landing.jpg",
    },
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
      "Not available yet. The template needs an explicit license and Node 24 support for local and Vercel runtimes.",
    startPath: "server/agents/nuxt/agent.ts",
  },
  {
    slug: "babysitter",
    name: "Babysitter",
    description: "Run scheduled Agent work on pull requests in trusted-host worktrees.",
    builtWith: ["Agent Definitions", "Schedule"],
    kind: "project",
    status: "pending",
    action: {
      kind: "source",
      label: "Source unavailable",
    },
    publicationNote:
      "Not available yet. The project needs public repository access and an explicit license.",
  },
];
