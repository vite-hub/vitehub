import "@vite-hub/ui/styles.css";
import { render, Workspace, type WorkspaceExample } from "@vite-hub/ui/workspace";
import { createApp, h, Suspense } from "vue";

const examples: WorkspaceExample[] = [
  { id: "hello", label: "Hello", files: { "index.html": "<h1>Hello</h1>" } },
  { id: "bye", label: "Bye", files: { "index.html": "<h1>Bye</h1>" } },
];
const runner = render(files => ({ html: files["index.html"] ?? "" }));

createApp({ render: () => h(Suspense, null, () => h(Workspace, { examples, name: "start", runner, share: false, start: true })) }).mount("#app");
