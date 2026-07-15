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
  license: string;
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
    slug: "babysitter",
    name: "Babysitter",
    description: "A ViteHub Agent and Schedule that owns pull requests from trusted-host worktrees.",
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
