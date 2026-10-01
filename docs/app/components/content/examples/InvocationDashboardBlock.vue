<script setup lang="ts">
import {
  agentInvocationContext,
  agentInvocationTitle,
  type AgentInvocationListItem,
  type AgentInvocationView,
} from "@vite-hub/ui";
import { computed, ref } from "vue";

// Synthetic, already-authorized records. In an application, load them from your Invocation store.
const invocations: AgentInvocationView[] = [
  {
    agentName: "reviewer",
    annotations: { "github.pullRequest": 1011, "github.repository": "vite-hub/vitehub" },
    configuration: {
      agent: { name: "reviewer", version: "1.0.0" },
      capabilities: [{ id: "workspace-shell", metadata: { access: "write" } }],
      driver: { kind: "provider", model: { id: "gpt-5.6", provider: "openai" }, provider: "codex" },
      runtime: { name: "node" },
      tools: [{ name: "exec_command", label: "Ran command", icon: "i-lucide-terminal" }],
      workspace: { mode: "write", name: "vitehub", sources: ["repository"] },
    },
    completedAt: "2026-08-23T09:04:12.000Z",
    createdAt: "2026-08-23T09:00:00.000Z",
    id: "ainv_overflow",
    observations: [
      {
        attributes: { "message.content": "Fix the error row overflow in the session list.", "message.id": "u1", "message.role": "user" },
        name: "agent.message.recorded",
        sequence: 1,
        timestamp: "2026-08-23T09:00:05.000Z",
        trace: { id: "trace_overflow" },
        type: "run",
      },
      {
        attributes: {
          "tool.id": "tests",
          "tool.name": "exec_command",
          "tool.output": { item: { aggregatedOutput: "10 tests passed\n", command: "pnpm test invocation-ui", exitCode: 0 } },
        },
        name: "agent.tool.finish",
        sequence: 2,
        timestamp: "2026-08-23T09:03:30.000Z",
        trace: { id: "trace_overflow" },
        type: "run",
      },
      {
        attributes: { "message.role": "assistant", "result.text": "Each row now reports its height. The focused tests pass." },
        name: "agent.message.recorded",
        sequence: 3,
        timestamp: "2026-08-23T09:04:10.000Z",
        trace: { id: "trace_overflow" },
        type: "run",
      },
    ],
    startedAt: "2026-08-23T09:00:01.000Z",
    status: "completed",
    title: "Fix invocation list overflow",
    traceId: "trace_overflow",
    updatedAt: "2026-08-23T09:04:12.000Z",
  },
  {
    agentName: "interface-engineer",
    createdAt: "2026-08-23T09:10:00.000Z",
    id: "ainv_navigation",
    observations: [
      {
        attributes: { "message.content": "Tighten the navigation spacing at mobile widths.", "message.id": "u2", "message.role": "user" },
        name: "agent.message.recorded",
        sequence: 1,
        timestamp: "2026-08-23T09:10:05.000Z",
        trace: { id: "trace_navigation" },
        type: "run",
      },
    ],
    startedAt: "2026-08-23T09:10:01.000Z",
    status: "running",
    title: "Polish Console navigation",
    traceId: "trace_navigation",
    updatedAt: "2026-08-23T09:15:00.000Z",
  },
  {
    agentName: "release-engineer",
    createdAt: "2026-08-23T08:40:00.000Z",
    error: { code: "ECONNRESET", message: "The package registry closed the connection before upload completed." },
    failedAt: "2026-08-23T08:42:00.000Z",
    id: "ainv_release",
    observations: [],
    startedAt: "2026-08-23T08:40:02.000Z",
    status: "failed",
    title: "Fix flaky release job",
    traceId: "trace_release",
    updatedAt: "2026-08-23T08:42:00.000Z",
  },
];

// Map full records to list summaries with the display helpers the Console uses.
const items = computed<AgentInvocationListItem[]>(() =>
  invocations.map((invocation) => ({
    agent: invocation.agentName,
    context: agentInvocationContext(invocation),
    description: invocation.error?.message,
    id: invocation.id,
    startedAt: invocation.startedAt,
    status: invocation.status,
    title: agentInvocationTitle(invocation),
    updatedAt: invocation.updatedAt,
  })),
);
const selectedId = ref(invocations[0]!.id);
const selected = computed(() => invocations.find((invocation) => invocation.id === selectedId.value)!);
const selectedActivityId = ref<string>();
const detailsOpen = ref(true);

function select(item: AgentInvocationListItem) {
  selectedId.value = item.id;
  selectedActivityId.value = undefined;
}
</script>

<template>
  <!-- Container queries size the panes from the block width, not the window width. -->
  <div class="@container h-[38rem] min-w-0 bg-default">
    <div
      class="grid h-full grid-rows-[9rem_minmax(0,1fr)] @2xl:grid-cols-[13rem_minmax(0,1fr)] @2xl:grid-rows-1"
      :class="detailsOpen ? '@4xl:grid-cols-[13rem_minmax(0,1fr)_18rem]' : ''"
    >
      <AgentInvocationList
        :items="items"
        :selected-id="selectedId"
        :now="Date.parse('2026-08-23T09:20:00.000Z')"
        class="min-h-0 border-b border-default @2xl:border-e @2xl:border-b-0"
        @select="select"
      />

      <div class="flex min-h-0 min-w-0 flex-col">
        <AgentInvocation
          :key="selected.id"
          :invocation="selected"
          :selected-activity-id="selectedActivityId"
          class="min-h-0 flex-1"
        >
          <template #actions>
            <UButton
              :icon="detailsOpen ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'"
              :aria-label="detailsOpen ? 'Hide details' : 'Show details'"
              :aria-pressed="detailsOpen"
              color="neutral"
              variant="ghost"
              size="xs"
              class="hidden @4xl:inline-flex"
              @click="detailsOpen = !detailsOpen"
            />
          </template>
        </AgentInvocation>
      </div>

      <AgentInvocationInspector
        v-if="detailsOpen"
        :invocation="selected"
        class="hidden min-h-0 border-s border-default @4xl:flex"
        @select-activity="selectedActivityId = $event"
      />
    </div>
  </div>
</template>
