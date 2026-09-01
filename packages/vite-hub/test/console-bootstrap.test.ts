import { readFileSync } from "node:fs";

import { useAgentInvocations } from "../../agent/src/invocations-vue";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import { describe, expect, it } from "vitest";

const consolePage = readFileSync(
  new URL("../src/console/runtime/components/console-app.vue", import.meta.url),
  "utf8",
);

it("releases bare Agents bootstrap when the newest invocation is unnamed", () => {
  expect(consolePage).toMatch(
    /if \(!firstInvocation\.agentName\) \{\s+initialBootstrapPending\.value = false;\s+usageSessionBootstrap = false;\s+return;\s+\}/,
  );
});

it("keeps shared refreshes on Usage free of Invocation requests", () => {
  expect(consolePage).toContain(
    "isUsageRoute.value ? Promise.resolve() : list.refresh()",
  );
});

describe.each(["agents-first", "invocations-first"] as const)(
  "Usage-to-Sessions bootstrap (%s)",
  (responseOrder) => {
    it("keeps one Invocation request alive while selecting the Agent", async () => {
      const scope = effectScope();
      const agentNames = ref<string[]>([]);
      const initialBootstrapPending = ref(true);
      const selectedAgentName = ref<string>();
      let preservedAgentSelection: string | undefined;
      const requests: Array<{
        resolve: (value: unknown) => void;
        signal: AbortSignal;
      }> = [];

      const list = scope.run(() => {
        const resource = useAgentInvocations({
          immediate: false,
          query: computed(() => ({
            ...(selectedAgentName.value ? { agent: selectedAgentName.value } : {}),
            limit: 10,
          })),
          request: (_path, { signal }) =>
            new Promise((resolve) => {
              requests.push({ resolve, signal: signal! });
            }),
          watch: false,
        });
        watch(agentNames, (names) => {
          if (!names.length || initialBootstrapPending.value || selectedAgentName.value) return;
          selectedAgentName.value = names[0];
        });
        watch(
          () => resource.invocations.value[0],
          (invocation) => {
            if (!invocation?.agentName || selectedAgentName.value) return;
            preservedAgentSelection = invocation.agentName;
            selectedAgentName.value = invocation.agentName;
            initialBootstrapPending.value = false;
          },
        );
        watch(selectedAgentName, (agentName) => {
          if (agentName && preservedAgentSelection === agentName) {
            preservedAgentSelection = undefined;
            return;
          }
          void resource.refresh();
        });
        return resource;
      })!;

      const listRequest = list.refresh();
      expect(requests).toHaveLength(1);
      const invocationResponse = {
        invocations: [
          {
            agentName: "alpha",
            createdAt: "2026-09-01T00:00:00.000Z",
            cursor: "cursor-1",
            id: "invocation-1",
            status: "running",
            traceId: "trace-1",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      };

      if (responseOrder === "agents-first") {
        agentNames.value = ["alpha"];
        await nextTick();
        requests[0]!.resolve(invocationResponse);
        await listRequest;
      } else {
        requests[0]!.resolve(invocationResponse);
        await listRequest;
        agentNames.value = ["alpha"];
      }
      await nextTick();

      expect(selectedAgentName.value).toBe("alpha");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.signal.aborted).toBe(false);
      scope.stop();
    });
  },
);
