import type { UIMessage } from "ai";
import type {
  AgentInvocationListItem,
  AgentInvocationView,
  ViteHubUIMessage,
  ViteHubUISession,
} from "../src/index.ts";

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
