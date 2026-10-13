import { readFileSync } from "node:fs";

import { useAgentInvocations } from "../../agent/src/invocations-vue";
import {
  isCapabilityFilterRouteTransition,
  refreshCapabilityFilteredInvocations,
  resetCapabilityFilterForRouteTransition,
  useConsoleSessionBootstrap,
} from "../src/console/runtime/components/console-session-bootstrap";
import { computed, effectScope, nextTick, ref, watch } from "vue";
import { createConsoleInvocationDeletion } from "../src/console/runtime/client/invocation-deletion.ts";
import { describe, expect, it, vi } from "vitest";

const consolePage = readFileSync(
  new URL("../src/console/runtime/components/console-app.vue", import.meta.url),
  "utf8",
);
const sessionInspector = readFileSync(
  new URL("../src/console/runtime/components/console-session-inspector.vue", import.meta.url),
  "utf8",
);
const sessionNavbar = readFileSync(
  new URL("../src/console/runtime/components/console-session-navbar.vue", import.meta.url),
  "utf8",
);

it("uses the Usage Agent filter when opening the sessions panel", () => {
  expect(consolePage).toContain("resolveUsageSessionsAgent(route.query, selectedAgentName.value)");
  expect(consolePage).toContain('@open-sessions="openSessionsFromUsage"');
});

it("opens the inspector on its launcher and keeps terminal session chrome quiet", () => {
  expect(consolePage).toContain('const inspectorActiveSurface = ref("");');
  expect(consolePage).toContain('ref<Array<"details" | "trace" | "workspace" | "capabilities">>([])');
  expect(consolePage).toContain("selectedDisplay.value?.status === \"pending\"");
  expect(consolePage).toContain(':aria-expanded="agentListOpen"');
  expect(consolePage).not.toContain("i-ph-caret-up-down-light");
  expect(sessionNavbar).toContain('v-if="refreshable" text="Refresh session"');
});

it("imports the invocation deletion helper the Console uses", () => {
  // A missing import compiles but throws ReferenceError on load, leaving every Console page blank.
  expect(consolePage).toContain("createConsoleInvocationDeletion()");
  expect(consolePage).toContain('import { createConsoleInvocationDeletion } from "../client/invocation-deletion";');
});

it("loads session filter values only for the filter menu or an active filter", () => {
  expect(consolePage).toContain(
    "if (filterOpen.value || selectedCapabilityId.value || selectedTriggeredBy.value) void loadCapabilityIds();",
  );
  expect(consolePage).toContain("if (open) void loadCapabilityIds();");
  expect(consolePage.match(/void loadCapabilityIds\(\)/g)).toHaveLength(2);
});

it("copies the session link and jumps from tool rows to calls", () => {
  expect(sessionNavbar).toContain('<UTooltip v-if="hasSelection" :text="linkCopyLabel">');
  expect(sessionNavbar).toContain("navigator.clipboard.writeText(window.location.href)");
  expect(sessionNavbar).toContain('role="status" aria-live="polite"');
  expect(sessionInspector).toContain(`<AgentCapabilityInspector v-else-if="tab === 'capabilities'" :invocation="invocation" @select-activity="emit('focusActivity', $event)" />`);
});

it("keeps inspector links and metadata compact", () => {
  expect(sessionInspector).toContain('class="session-inspector__surface-launcher"');
  expect(sessionInspector).toContain('<template #identityActions>');
  expect(sessionInspector).toContain('class="session-inspector__instructions-link"');
  expect(sessionInspector).not.toContain("Find root AGENTS.md in Workspace");
});

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
  const selectedTriggeredBy = ref<string | undefined>("Ferdinand");
  let refreshes = 0;

  expect(resetCapabilityFilterForRouteTransition({
    preserve: false,
    routeChanged: true,
    scheduleRefresh: () => refreshes++,
    selectedCapabilityId,
    selectedTriggeredBy,
  })).toBe(true);
  expect(selectedCapabilityId.value).toBeUndefined();
  expect(selectedTriggeredBy.value).toBeUndefined();
  expect(refreshes).toBe(1);
});

it("uses server-backed session filters and a larger initial page", () => {
  expect(consolePage).toContain("query.triggeredBy = selectedTriggeredBy.value");
  expect(consolePage).toContain("limit: 50");
  expect(consolePage).toContain("Used capability");
  expect(consolePage).toContain("Triggered by");
  expect(consolePage).toContain('@end-reached="loadMoreSessions"');
  expect(consolePage).toContain("No matching sessions");
  expect(consolePage).toContain("Clear filters");
  expect(consolePage).not.toContain('icon: "i-ph-robot-light"');
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

it("does not preserve Capability filters for unrelated navigation during refresh", () => {
  const expected = { agent: "alpha", invocation: undefined };

  expect(isCapabilityFilterRouteTransition(expected, {
    agent: "alpha",
    invocation: undefined,
  })).toBe(true);
  expect(isCapabilityFilterRouteTransition(expected, {
    agent: "alpha",
    invocation: "invocation-b",
  })).toBe(false);
  expect(isCapabilityFilterRouteTransition(expected, {
    agent: "beta",
    invocation: undefined,
  })).toBe(false);
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

// Execute the component's deletion handler with reactive state and a router boundary.
it.each([false, true])("clears a deleted route before list changes when refresh fails: %s", async (refreshFails) => {
  const selectedInvocationId = ref<string | undefined>("deleted");
  const route = { name: "vitehub-console-invocation", params: { invocation: "deleted" as string | undefined } };
  const selectedAgentName = ref("agent");
  const routeInvocation = computed(() => route.params.invocation);
  const deletedInvocations = createConsoleInvocationDeletion();
  const list = {
    invocations: ref([{ id: "deleted" }, { id: "remaining" }]),
    refresh: vi.fn(async () => {}),
  };
  list.refresh.mockImplementation(async () => {
    // A stale response can still include the invocation after confirmed deletion.
    list.invocations.value = [{ id: "deleted" }, { id: "remaining" }];
    if (refreshFails) throw new Error("Refresh failed");
  });
  const closeDetails = vi.fn();
  const router = { replace: vi.fn(async () => { route.params.invocation = undefined; }) };
  const stop = watch(list.invocations, () => {
    // A list change must not allow route synchronization to restore the deleted ID.
    expect(route.params.invocation).toBeUndefined();
    if (route.params.invocation) selectedInvocationId.value = route.params.invocation;
  }, { flush: "sync" });
  const source = consolePage.slice(consolePage.indexOf("async function removeDeletedInvocation("), consolePage.indexOf("async function startNewChat("))
    .replace("(id: string): Promise<void>", "(id)");
  // SAFETY: The function is read from the component and receives its declared dependencies.
  const remove = new Function("list", "selectedAgentName", "route", "routeInvocation", "deletedInvocations", "selectedInvocationId", "closeDetails", "router", "resolveConsoleRouteName", "encodeAgentRouteParam", `${source}; return removeDeletedInvocation;`)(
    list, selectedAgentName, route, routeInvocation, deletedInvocations, selectedInvocationId, closeDetails, router, (_name: unknown, target: string) => target, (name: string) => name,
  ) as (id: string) => Promise<void>;
  try {
    await expect(remove("deleted")).resolves.toBeUndefined();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith({ name: "vitehub-console-agent", params: { agent: "agent" } });
    expect(closeDetails).toHaveBeenCalledOnce();
    expect(list.invocations.value).toEqual([{ id: "remaining" }]);
    expect(selectedInvocationId.value).not.toBe("deleted");
    expect(route.params.invocation).toBeUndefined();
    expect(list.refresh).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
