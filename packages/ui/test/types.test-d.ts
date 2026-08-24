import type { UIMessage } from "ai";
import {
  AgentCodeView,
  AgentFile,
  AgentFileDiff,
  AgentMultiFileDiff,
  AgentPatchDiff,
  AgentUnresolvedFile,
  getSingularPatch,
  type CodeViewItem,
  type FileContents,
} from "../src/index.ts";
import type {
  AgentInvocationListItem,
  AgentInvocationView,
  ViteHubUIMessage,
  ViteHubUISession,
} from "../src/index.ts";

const file: FileContents = { contents: "export const ready = true\n", name: "ready.ts" };
const fileDiff = getSingularPatch(`--- a/ready.ts
+++ b/ready.ts
@@ -1 +1 @@
-false
+true`);
const codeViewItems: CodeViewItem[] = [
  { file, id: "file", type: "file" },
  { fileDiff, id: "diff", type: "diff" },
];

void AgentCodeView;
void AgentFile;
void AgentFileDiff;
void AgentMultiFileDiff;
void AgentPatchDiff;
void AgentUnresolvedFile;
void codeViewItems;

const listItem: AgentInvocationListItem = {
  id: "invocation-1",
  project: "vitehub",
  status: "running",
  title: "Improve the console",
};
void listItem;

declare const message: ViteHubUIMessage<{ createdAt: string }, { weather: { city: string } }>;
const compatible: UIMessage = message;
const session: ViteHubUISession<typeof message> = { id: "session-1", messages: [message] };
const invocation: AgentInvocationView = {
  configuration: {
    capabilities: [{ id: "workspace-shell", metadata: { mode: "write" } }],
    driver: { kind: "provider", model: { id: "codex", provider: "openai" } },
    instructions: ["Inspect the repository."],
    runtime: { name: "node" },
    tools: [{ name: "exec" }],
    workspace: { mode: "write", name: "review", sources: ["repository"] },
  },
  createdAt: "2026-08-22T00:00:00.000Z",
  id: "ainv_1",
  observations: [],
  status: "running",
  traceId: "trace_1",
  updatedAt: "2026-08-22T00:00:00.000Z",
};

void compatible;
void invocation;
void session;
