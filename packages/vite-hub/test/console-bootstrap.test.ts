import { readFileSync } from "node:fs";

import { useAgentInvocations } from "../../agent/src/invocations-vue";
import {
  refreshCapabilityFilteredInvocations,
  resetCapabilityFilterForRouteTransition,
  useConsoleSessionBootstrap,
} from "../src/console/runtime/components/console-session-bootstrap";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import { describe, expect, it } from "vitest";

const consolePage = readFileSync(
  new URL("../src/console/runtime/components/console-app.vue", import.meta.url),
  "utf8",
);

it("releases bare Agents bootstrap when the newest invocation is unnamed", async () => {
  const scope = effectScope();
  const firstInvocation = ref<{ agentName?: string }>();
  const initialBootstrapPending = ref(true);
  const selectedAgentName = ref<string>();

  scope.run(() => {
    useConsoleSessionBootstrap({
      agentNames: ref([]),
      firstInvocation,
      initialBootstrapPending,
      isLoading: ref(false),
      isUsageRoute: ref(false),
      scheduleRefresh: () => undefined,
      selectedAgentName,
    });
  });

  firstInvocation.value = {};
  await nextTick();

  expect(initialBootstrapPending.value).toBe(false);
  expect(selectedAgentName.value).toBeUndefined();
  scope.stop();
});

it("keeps shared refreshes on Usage free of Invocation requests", () => {
  expect(consolePage).toContain(
    "isUsageRoute.value ? Promise.resolve() : list.refresh()",
  );
});

it("selects an Invocation returned by the active Capability filter", async () => {
  const routeInvocation = ref<string | undefined>("invocation-a");
  const invocations = ref([{ id: "invocation-a" }]);
  const selectedInvocationId = ref<string>();
  const scope = effectScope();
  let completeRefresh: (() => void) | undefined;

  scope.run(() => {
    watch(
      [routeInvocation, computed(() => invocations.value[0])],
      ([requestedInvocation, firstInvocation]) => {
        selectedInvocationId.value = requestedInvocation || firstInvocation?.id;
      },
      { immediate: true },
    );
  });

  const transition = refreshCapabilityFilteredInvocations({
    navigate: async () => {
      expect(invocations.value).toEqual([]);
      routeInvocation.value = undefined;
      await nextTick();
    },
    refresh: () => {
      invocations.value = [];
      return new Promise<void>((resolve) => {
        completeRefresh = () => {
          invocations.value = [{ id: "invocation-b" }];
          resolve();
        };
      });
    },
  });

  await nextTick();
  expect(selectedInvocationId.value).toBeUndefined();
  completeRefresh?.();
  await transition;
  await nextTick();

  expect(selectedInvocationId.value).toBe("invocation-b");
  expect(routeInvocation.value).toBeUndefined();
  scope.stop();
});

it("clears Capability filters for external Agent and Invocation route transitions", () => {
  const selectedCapabilityId = ref<string | undefined>("papercuts");
  let refreshes = 0;

  expect(resetCapabilityFilterForRouteTransition({
    preserve: false,
    routeChanged: true,
    scheduleRefresh: () => refreshes++,
    selectedCapabilityId,
  })).toBe(true);
  expect(selectedCapabilityId.value).toBeUndefined();
  expect(refreshes).toBe(1);
});

it("preserves Capability filters during their own route transition", () => {
  const selectedCapabilityId = ref<string | undefined>("papercuts");

  expect(resetCapabilityFilterForRouteTransition({
    preserve: true,
    routeChanged: true,
    scheduleRefresh: () => undefined,
    selectedCapabilityId,
  })).toBe(false);
  expect(selectedCapabilityId.value).toBe("papercuts");
});

describe.each(["agents-first", "invocations-first"] as const)(
  "Usage-to-Sessions bootstrap (%s)",
  (responseOrder) => {
    it("keeps one Invocation request alive while selecting the Agent", async () => {
      const scope = effectScope();
      const agentNames = ref<string[]>([]);
      const initialBootstrapPending = ref(true);
      const selectedAgentName = ref<string>();
      let refreshQueued = false;
      const requests: Array<{
        path: string;
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
          request: (path, { signal }) =>
            new Promise((resolve) => {
              requests.push({ path, resolve, signal: signal! });
            }),
          watch: false,
        });
        const scheduleRefresh = () => {
          if (refreshQueued) return;
          refreshQueued = true;
          void nextTick(() => {
            refreshQueued = false;
            void resource.refresh();
          });
        };
        useConsoleSessionBootstrap({
          agentNames,
          firstInvocation: computed(() => resource.invocations.value[0]),
          initialBootstrapPending,
          isUsageRoute: ref(false),
          isLoading: resource.isLoading,
          scheduleRefresh,
          selectedAgentName,
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
      expect(requests).toHaveLength(2);
      expect(requests[0]!.signal.aborted).toBe(false);
      expect(requests[1]!.path).toContain("agent=alpha");
      requests[1]!.resolve(invocationResponse);
      await nextTick();
      scope.stop();
    });
  },
);
