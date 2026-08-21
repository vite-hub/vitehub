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
  const request = (<T>(path: string, options: Parameters<AgentInvocationRequester>[1]) =>
    new Promise<T>((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
      calls.push({ options, path, reject, resolve });
    })) as AgentInvocationRequester;
  return { calls, request };
}

function record(id: string): AgentInvocationRecord {
  return { id } as AgentInvocationRecord;
}

function observation(sequence: number): TraceEventLogEntry {
  return { sequence } as TraceEventLogEntry;
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
    const request = <T>(path: string, options: { signal?: AbortSignal }) => fetch(path, options).then(response => response.json() as Promise<T>);
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
    await refresh;
    expect(resource.invocations.value).toEqual([record("inv-2")]);
    scope.stop();
  });

  it("polls after completion and stop cancels future work", async () => {
    vi.useFakeTimers();
    const requestMock = vi.fn(async () => ({
      cursor: "next",
      invocations: [record("inv-1")],
    }) as AgentInvocationListResult);
    const request = requestMock as unknown as AgentInvocationRequester;
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
