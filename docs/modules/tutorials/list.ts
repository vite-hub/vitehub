import type { RunnableTutorialSource } from "./build";

/**
 * Tutorials that run in the reader's browser at `/tutorials/<slug>`.
 * The lesson is the docs page, so the prose has one source. The fixture is the app after the last step.
 */
export const runnableTutorials: RunnableTutorialSource[] = [
  { slug: "first-server-primitive", page: "/docs/getting-started/first-server-primitive", fixture: "server-primitives" },
  { slug: "first-agent", page: "/docs/getting-started/first-agent", fixture: "first-agent" },
  { slug: "decisions", page: "/docs/decisions/get-started", fixture: "decisions" },
];
