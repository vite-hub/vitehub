import type { DocsRunnableExample, DocsRunnableLesson } from "@vite-hub/docs";

/**
 * Lessons that run in the reader's browser at `/learn/<slug>`.
 * The lesson is the docs page, so the prose has one source. The fixture is the app after the last step.
 */
export const runnableTutorials: DocsRunnableLesson[] = [
  { slug: "first-server-primitive", page: "/docs/getting-started/first-server-primitive", fixture: "server-primitives" },
  { slug: "first-agent", page: "/docs/getting-started/first-agent", fixture: "first-agent" },
  { slug: "choices", page: "/docs/choices/get-started", fixture: "choices" },
];

/** The templates of `/playground`, in menu order. The first one opens by default. */
export const playgroundTemplates: DocsRunnableExample[] = [
  { id: "kv", label: "KV", description: "Store and read a value.", fixture: "server-primitives", open: "server/api/settings.post.ts", preview: "/api/health" },
  { id: "blob", label: "Blob", description: "Write a file and read it back.", fixture: "playground-blob", open: "server/api/note.get.ts", preview: "/api/note" },
  { id: "queue", label: "Queue", description: "Run a job in the background.", fixture: "playground-queue", open: "server/queues/welcome-email.ts", preview: "/api/welcome" },
  { id: "cache", label: "Cache", description: "Cache a route for 10 seconds.", fixture: "playground-cache", open: "server/api/time.get.ts", preview: "/api/time" },
  { id: "rate-limit", label: "Rate Limit", description: "Allow three requests a minute.", fixture: "playground-rate-limit", open: "server/api/upload.get.ts", preview: "/api/upload" },
  { id: "agent", label: "Agent", description: "An Agent that a route invokes.", fixture: "first-agent", open: "server/agents/greeting.ts", preview: "/api/health" },
  { id: "channels", label: "Channels", description: "Chat with an Agent in a simulated Slack.", fixture: "playground-channels", open: "server/agents/support.ts", preview: "/_vitehub/agents/support/webhooks/slack" },
  { id: "ui", label: "ViteHub UI", description: "A Vue app with a dialog, tabs, a menu, and toasts.", fixture: "playground-ui", open: "src/App.vue", preview: "/" },
];
