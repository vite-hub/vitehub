import { effectScope, nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAgentInvocation, useAgentInvocations } from "../src/invocations-vue.ts";

import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { AgentInvocationListResult, AgentInvocationRecord } from "../src/invocations.ts";
import type {
  AgentInvocationDetailResult,
  AgentInvocationRequester,
} from "../src/invocations-vue.ts";

interface RequestCall {
  options: Parameters<AgentInvocationRequester>[1];
  path: string;
  reject: (error: unknown) => void;
  resolve: (value: any) => void;
}

function controlledRequester() {
  const calls: RequestCall[] = [];
  const request: AgentInvocationRequester = (path, options) =>
    new Promise<unknown>((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      calls.push({ options, path, reject, resolve });
    });
  return { calls, request };
}

function record(id: string): AgentInvocationRecord {
  return {
    createdAt: "2026-08-22T12:00:00.000Z",
    cursor: id,
    id,
    observations: [],
    status: "running",
    traceId: `trace-${id}`,
    updatedAt: "2026-08-22T12:00:00.000Z",
  };
}

function observation(sequence: number): TraceEventLogEntry {
  return {
    name: "agent.invocation.running",
    sequence,
    timestamp: "2026-08-22T12:00:00.000Z",
    type: "lifecycle",
  };
}

async function settle() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Agent Invocation Vue composables", () => {
  it("uses the same-origin endpoint with an application requester", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ invocations: [] }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const scope = effectScope();
    const requestUnknown = (path: string, options: { signal?: AbortSignal }): Promise<unknown> => fetch(path, options).then(response => response.json());
    // SAFETY: This fixture controls the response body and supplies the exact list shape consumed by the composable.
    const request = requestUnknown as AgentInvocationRequester;
    const resource = scope.run(() => useAgentInvocations({ immediate: false, request }))!;

    await expect(resource.refresh()).resolves.toEqual({ invocations: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/invocations", {
      signal: expect.any(AbortSignal),
    });
    scope.stop();
  });

  it("reacts to list queries and ignores superseded requests", async () => {
    const { calls, request } = controlledRequester();
    const query = ref({ status: ["queued", "running"], limit: 20 });
    const scope = effectScope();
    const resource = scope.run(() =>
      useAgentInvocations({
        baseURL: "/internal/invocations",
        query,
        request,
      }),
    )!;

    expect(calls[0]!.path).toBe("/internal/invocations?status=queued&status=running&limit=20");
    expect(resource.isLoading.value).toBe(true);

    query.value = { status: ["finished"], limit: 10 };
    await nextTick();
    expect(calls[0]!.options.signal?.aborted).toBe(true);
    expect(calls[1]!.path).toBe("/internal/invocations?status=finished&limit=10");

    calls[1]!.resolve({
      cursor: "next",
      invocations: [record("inv-2")],
    } satisfies AgentInvocationListResult);
    await settle();
    expect(resource.invocations.value).toEqual([record("inv-2")]);
    expect(resource.cursor.value).toBe("next");
    expect(resource.isLoading.value).toBe(false);
    expect(resource.error.value).toBeNull();

    const older = resource.loadMore();
    expect(calls[2]!.path).toBe(
      "/internal/invocations?status=finished&limit=10&cursor=next",
    );
    calls[2]!.resolve({ invocations: [record("inv-3")] } satisfies AgentInvocationListResult);
    await older;
    expect(resource.invocations.value).toEqual([record("inv-2"), record("inv-3")]);
    expect(resource.cursor.value).toBeUndefined();
    scope.stop();
  });

  it("loads invocation observations with a reactive encoded id", async () => {
    const { calls, request } = controlledRequester();
    const id = ref<string | undefined>("team/invocation 1");
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocation(id, { request }))!;

    expect(calls[0]!.path).toBe("/api/invocations/team%2Finvocation%201");
    calls[0]!.resolve({
      invocation: record("team/invocation 1"),
      observations: [observation(1)],
    } satisfies AgentInvocationDetailResult);
    await settle();
    expect(resource.invocation.value?.id).toBe("team/invocation 1");
    expect(resource.observations.value).toEqual([observation(1)]);

    id.value = undefined;
    await settle();
    expect(resource.invocation.value).toBeNull();
    expect(resource.observations.value).toEqual([]);

    id.value = "inv-2";
    await nextTick();
    expect(calls[1]!.path).toBe("/api/invocations/inv-2");
    scope.stop();
    expect(calls[1]!.options.signal?.aborted).toBe(true);
    expect(resource.isLoading.value).toBe(false);
  });

  it("does not paginate while refreshing the first page", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ request }))!;

    calls[0]!.resolve({
      cursor: "next",
      invocations: [record("inv-1")],
    } satisfies AgentInvocationListResult);
    await settle();

    const refresh = resource.refresh();
    expect(resource.isLoading.value).toBe(true);
    await expect(resource.loadMore()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);

    calls[1]!.resolve({ invocations: [record("inv-2")] } satisfies AgentInvocationListResult);
    await settle();
    calls[2]!.resolve({ invocation: record("inv-1"), observations: [] });
    await refresh;
    expect(resource.invocations.value.map(invocation => invocation.id)).toEqual(["inv-2", "inv-1"]);
    scope.stop();
  });

  it("keeps lazy-loaded pages when polling refreshes the first page", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ request }))!;

    calls[0]!.resolve({ cursor: "page-2", invocations: [record("inv-2"), record("inv-1")] });
    await settle();
    const loadMore = resource.loadMore();
    calls[1]!.resolve({ cursor: "page-3", invocations: [record("inv-0")] });
    await loadMore;

    const refresh = resource.refresh();
    calls[2]!.resolve({ cursor: "new-page-2", invocations: [record("inv-3"), record("inv-2")] });
    await settle();
    calls[3]!.resolve({ invocation: record("inv-1"), observations: [] });
    calls[4]!.resolve({ invocation: record("inv-0"), observations: [] });
    await refresh;

    expect(resource.invocations.value.map(invocation => invocation.id)).toEqual(["inv-3", "inv-2", "inv-1", "inv-0"]);
    expect(resource.cursor.value).toBe("page-3");
    scope.stop();
  });

  it("reconciles retained pages while filters are active", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({
      query: { status: "running" },
      request,
    }))!;

    calls[0]!.resolve({ cursor: "page-2", invocations: [record("inv-2"), record("inv-1")] });
    await settle();
    const loadMore = resource.loadMore();
    calls[1]!.resolve({ invocations: [record("inv-0")] });
    await loadMore;

    const refresh = resource.refresh();
    calls[2]!.resolve({ cursor: "page-2", invocations: [record("inv-3"), record("inv-2")] });
    await settle();
    calls[3]!.resolve({ invocation: record("inv-1"), observations: [] });
    await settle();
    calls[4]!.resolve({
      invocation: { ...record("inv-0"), completedAt: "2026-08-22T12:01:00.000Z", status: "completed" },
      observations: [],
    });
    await refresh;

    expect(resource.invocations.value.map(invocation => invocation.id)).toEqual(["inv-3", "inv-2", "inv-1"]);
    expect(calls).toHaveLength(5);
    scope.stop();
  });

  it("refreshes retained summaries without a filter", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ request }))!;

    calls[0]!.resolve({ cursor: "page-2", invocations: [record("inv-2")] });
    await settle();
    const loadMore = resource.loadMore();
    calls[1]!.resolve({ invocations: [record("inv-1")] });
    await loadMore;

    const refresh = resource.refresh();
    calls[2]!.resolve({ cursor: "page-2", invocations: [record("inv-3")] });
    await settle();
    calls[3]!.resolve({
      invocation: {
        ...record("inv-2"),
        status: "completed",
        updatedAt: "2026-08-22T12:01:00.000Z",
      },
      observations: [],
    });
    calls[4]!.resolve({ invocation: record("inv-1"), observations: [] });
    await refresh;

    expect(resource.invocations.value.map(invocation => ({
      id: invocation.id,
      status: invocation.status,
      updatedAt: invocation.updatedAt,
    }))).toEqual([
      { id: "inv-3", status: "running", updatedAt: "2026-08-22T12:00:00.000Z" },
      { id: "inv-2", status: "completed", updatedAt: "2026-08-22T12:01:00.000Z" },
      { id: "inv-1", status: "running", updatedAt: "2026-08-22T12:00:00.000Z" },
    ]);
    scope.stop();
  });

  it("bounds retained reconciliation work across polls", async () => {
    const request = vi.fn<AgentInvocationRequester>();
    const retained = Array.from({ length: 25 }, (_, index) => record(`inv-${index}`));
    request.mockResolvedValueOnce({ invocations: retained });
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { status: "running" }, request }))!;
    await settle();

    request.mockResolvedValueOnce({ invocations: [record("new")] });
    for (const invocation of retained.slice(0, 20)) {
      request.mockResolvedValueOnce({ invocation, observations: [] });
    }
    await resource.refresh();
    expect(request).toHaveBeenCalledTimes(22);

    request.mockResolvedValueOnce({ invocations: [record("newer")] });
    for (const invocation of [...retained.slice(20), ...retained.slice(0, 15)]) {
      request.mockResolvedValueOnce({ invocation, observations: [] });
    }
    await resource.refresh();
    expect(request).toHaveBeenCalledTimes(43);
    scope.stop();
  });

  it("refreshes retained summaries during filtered reconciliation", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { search: "inv" }, request }))!;

    calls[0]!.resolve({ invocations: [record("inv-1")] });
    await settle();
    const refresh = resource.refresh();
    calls[1]!.resolve({ invocations: [record("inv-2")] });
    await settle();
    calls[2]!.resolve({
      invocation: {
        ...record("inv-1"),
        completedAt: "2026-08-22T12:01:00.000Z",
        status: "completed",
        updatedAt: "2026-08-22T12:01:00.000Z",
      },
      observations: [],
    });
    await refresh;

    expect(resource.invocations.value).toEqual([
      record("inv-2"),
      expect.objectContaining({ id: "inv-1", status: "completed", updatedAt: "2026-08-22T12:01:00.000Z" }),
    ]);
    scope.stop();
  });

  it("removes first-page records that leave a search filter", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { search: "running" }, request }))!;

    calls[0]!.resolve({ invocations: [record("inv-1")] });
    await settle();
    const refresh = resource.refresh();
    calls[1]!.resolve({ invocations: [] });
    await settle();
    calls[2]!.resolve({
      invocation: { ...record("inv-1"), completedAt: "2026-08-22T12:01:00.000Z", status: "completed" },
      observations: [],
    });
    await refresh;

    expect(resource.invocations.value).toEqual([]);
    scope.stop();
  });

  it("excludes observations when reconciling search departures", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { search: "running" }, request }))!;

    calls[0]!.resolve({ invocations: [record("inv-1")] });
    await settle();
    const refresh = resource.refresh();
    calls[1]!.resolve({ invocations: [] });
    await settle();
    calls[2]!.resolve({
      invocation: {
        ...record("inv-1"),
        completedAt: "2026-08-22T12:01:00.000Z",
        observations: [{ value: "running" }],
        status: "completed",
      },
      observations: [{ name: "output", sequence: 1, timestamp: "2026-08-22T12:00:30.000Z", type: "run", value: "running" }],
    });
    await refresh;

    expect(resource.invocations.value).toEqual([]);
    scope.stop();
  });

  it("retries failed filtered departure checks", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { status: "running" }, request }))!;

    calls[0]!.resolve({ invocations: [record("inv-1")] });
    await settle();
    const firstRefresh = resource.refresh();
    calls[1]!.resolve({ invocations: [] });
    await settle();
    calls[2]!.reject(new Error("temporary failure"));
    await firstRefresh;
    expect(resource.invocations.value).toEqual([record("inv-1")]);

    const secondRefresh = resource.refresh();
    calls[3]!.resolve({ invocations: [] });
    await settle();
    calls[4]!.resolve({
      invocation: { ...record("inv-1"), completedAt: "2026-08-22T12:01:00.000Z", status: "completed" },
      observations: [],
    });
    await secondRefresh;

    expect(resource.invocations.value).toEqual([]);
    expect(calls).toHaveLength(5);
    scope.stop();
  });

  it("removes displaced records that no longer match the status filter", async () => {
    const { calls, request } = controlledRequester();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ query: { status: "running" }, request }))!;

    calls[0]!.resolve({ invocations: [record("inv-1")] });
    await settle();
    const refresh = resource.refresh();
    calls[1]!.resolve({ invocations: [] });
    await settle();
    calls[2]!.resolve({
      invocation: { ...record("inv-1"), completedAt: "2026-08-22T12:01:00.000Z", status: "completed" },
      observations: [],
    });
    await refresh;

    expect(resource.invocations.value).toEqual([]);
    scope.stop();
  });

  it("polls after completion and stop cancels future work", async () => {
    vi.useFakeTimers();
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    const requestMock = vi.fn(async () => ({
      cursor: "next",
      invocations: [record("inv-1")],
    }) as AgentInvocationListResult);
    const request: AgentInvocationRequester = (_path, _options) => requestMock();
    const scope = effectScope();
    const resource = scope.run(() => useAgentInvocations({ pollInterval: 100, request }))!;

    await settle();
    expect(requestMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(requestMock).toHaveBeenCalledTimes(2);

    resource.stop();
    await expect(resource.loadMore()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(requestMock).toHaveBeenCalledTimes(2);
    await expect(resource.refresh()).resolves.toBeUndefined();
    resource.cursor.value = "next";
    await expect(resource.loadMore()).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it("supports manual loading without watching reactive inputs", async () => {
    const { calls, request } = controlledRequester();
    const id = ref<string | undefined>("inv-1");
    const scope = effectScope();
    const resource = scope.run(() =>
      useAgentInvocation(id, {
        immediate: false,
        request,
        watch: false,
      }),
    )!;

    expect(calls).toHaveLength(0);
    id.value = "inv-2";
    await nextTick();
    expect(calls).toHaveLength(0);

    const pending = resource.refresh();
    expect(calls[0]!.path).toBe("/api/invocations/inv-2");
    calls[0]!.resolve({
      invocation: record("inv-2"),
      observations: [],
    } satisfies AgentInvocationDetailResult);
    await pending;
    expect(resource.invocation.value?.id).toBe("inv-2");
    scope.stop();
  });
});
