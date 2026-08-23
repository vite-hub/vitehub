import { onScopeDispose, shallowRef, toValue, watch } from "vue";
import * as v from "valibot";

import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import type { AgentInvocationListResult, AgentInvocationSummary } from "./invocations.ts";

export interface AgentInvocationRequestOptions {
  signal?: AbortSignal;
}

export type AgentInvocationRequester = (
  path: string,
  options: AgentInvocationRequestOptions,
) => Promise<unknown>;

type QueryValue = boolean | number | string | null | undefined;
type AgentInvocationQuery = Record<string, QueryValue | readonly QueryValue[]> & {
  search?: string;
};

export interface UseAgentInvocationsOptions {
  baseURL?: MaybeRefOrGetter<string>;
  immediate?: boolean;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  query?: MaybeRefOrGetter<AgentInvocationQuery>;
  request: AgentInvocationRequester;
  watch?: boolean;
}

export interface UseAgentInvocationsReturn {
  cursor: ShallowRef<string | undefined>;
  error: ShallowRef<unknown>;
  invocations: ShallowRef<readonly AgentInvocationSummary[]>;
  isLoading: ShallowRef<boolean>;
  isLoadingMore: ShallowRef<boolean>;
  loadMore: () => Promise<AgentInvocationListResult | undefined>;
  refresh: () => Promise<AgentInvocationListResult | undefined>;
  stop: () => void;
}

export interface AgentInvocationDetailResult {
  invocation: AgentInvocationSummary;
  observations: readonly TraceEventLogEntry[];
}

export interface UseAgentInvocationOptions {
  baseURL?: MaybeRefOrGetter<string>;
  immediate?: boolean;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  request: AgentInvocationRequester;
  watch?: boolean;
}

export interface UseAgentInvocationReturn {
  error: ShallowRef<unknown>;
  invocation: ShallowRef<AgentInvocationSummary | null>;
  isLoading: ShallowRef<boolean>;
  observations: ShallowRef<readonly TraceEventLogEntry[]>;
  refresh: () => Promise<AgentInvocationDetailResult | undefined>;
  stop: () => void;
}

const defaultBaseURL = "/api/invocations";

function isInvocationStatus(value: unknown): value is AgentInvocationSummary["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

const invocationStatusSchema = v.picklist([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const annotationValueSchema = v.union([v.boolean(), v.number(), v.string(), v.null()]);
const invocationSummarySchema = v.looseObject({
  agentName: v.optional(v.string()),
  annotations: v.optional(v.record(v.string(), annotationValueSchema)),
  cancelledAt: v.optional(v.string()),
  channelId: v.optional(v.string()),
  completedAt: v.optional(v.string()),
  createdAt: v.string(),
  cursor: v.string(),
  error: v.optional(v.object({ message: v.string(), name: v.optional(v.string()) })),
  failedAt: v.optional(v.string()),
  id: v.string(),
  origin: v.optional(v.string()),
  startedAt: v.optional(v.string()),
  status: invocationStatusSchema,
  threadId: v.optional(v.string()),
  traceId: v.string(),
  updatedAt: v.string(),
});
const traceEventLogEntrySchema = v.looseObject({
  attributes: v.optional(v.record(v.string(), v.unknown())),
  name: v.string(),
  sequence: v.number(),
  timestamp: v.string(),
  trace: v.optional(
    v.object({
      id: v.string(),
      parentId: v.optional(v.string()),
      sampled: v.optional(v.boolean()),
    }),
  ),
  type: v.picklist(["approval", "capability", "error", "lifecycle", "policy", "run"]),
});
const invocationListResultSchema = v.object({
  cursor: v.optional(v.string()),
  invocations: v.array(invocationSummarySchema),
});
const invocationDetailResultSchema = v.object({
  invocation: invocationSummarySchema,
  observations: v.array(traceEventLogEntrySchema),
});

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseInvocationListResult(value: unknown): AgentInvocationListResult {
  return v.parse(invocationListResultSchema, value);
}

function parseInvocationDetailResult(value: unknown): AgentInvocationDetailResult {
  return v.parse(invocationDetailResultSchema, value);
}

function appendQuery(
  path: string,
  query: Record<string, QueryValue | readonly QueryValue[]> | undefined,
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry !== null && entry !== undefined) params.append(key, String(entry));
    }
  }
  const suffix = params.toString();
  if (!suffix) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${suffix}`;
}

function detailPath(baseURL: string, id: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${encodeURIComponent(id)}`;
}

interface InvocationResourceOptions<T> {
  apply: (value: T) => void;
  beforeLoad?: () => void;
  beforeSourceChange?: () => void;
  clear: () => void;
  immediate: boolean;
  load: (signal: AbortSignal) => Promise<T | undefined>;
  pollingPaused?: () => boolean;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  source: () => unknown;
  watch: boolean;
}

function useInvocationResource<T>(options: InvocationResourceOptions<T>) {
  const error = shallowRef<unknown>(null);
  const isLoading = shallowRef(false);
  let active: AbortController | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    clearTimer();
    if (stopped || active) return;
    const interval = options.pollInterval === undefined ? false : toValue(options.pollInterval);
    if (interval === false || interval === undefined || !Number.isFinite(interval) || interval <= 0)
      return;
    timer = setTimeout(() => {
      if (options.pollingPaused?.()) {
        schedule();
        return;
      }
      void refresh();
    }, interval);
  }

  async function refresh(): Promise<T | undefined> {
    if (stopped) return;
    options.beforeLoad?.();
    clearTimer();
    active?.abort();
    const controller = new AbortController();
    active = controller;
    isLoading.value = true;
    error.value = null;
    try {
      const result = await options.load(controller.signal);
      if (active !== controller) return;
      if (result === undefined) options.clear();
      else options.apply(result);
      return result;
    } catch (cause) {
      if (active !== controller || isAbortError(cause)) return;
      error.value = cause;
    } finally {
      if (active === controller) {
        active = undefined;
        isLoading.value = false;
        schedule();
      }
    }
  }

  const stopSource = options.watch
    ? watch(
        options.source,
        () => {
          options.beforeSourceChange?.();
          void refresh();
        },
        { deep: true },
      )
    : undefined;
  const stopPolling =
    options.pollInterval === undefined
      ? undefined
      : watch(() => toValue(options.pollInterval), schedule);

  function stop() {
    if (stopped) return;
    stopped = true;
    stopSource?.();
    stopPolling?.();
    clearTimer();
    active?.abort();
    active = undefined;
    isLoading.value = false;
  }

  onScopeDispose(stop, true);
  if (options.immediate) void refresh();
  else schedule();

  return { error, isLoading, refresh, schedule, stop };
}

export function useAgentInvocations(
  options: UseAgentInvocationsOptions,
): UseAgentInvocationsReturn {
  const invocations = shallowRef<readonly AgentInvocationSummary[]>([]);
  const cursor = shallowRef<string | undefined>();
  const isLoadingMore = shallowRef(false);
  const request = options.request;
  const baseURL = options.baseURL ?? defaultBaseURL;
  let loadMoreController: AbortController | undefined;
  let firstPage: readonly AgentInvocationSummary[] = [];
  let revision = 0;
  let resetFirstPage = true;
  let departedIds = new Set<string>();
  let pendingDepartureIds = new Set<string>();
  let sourceSignature: string | undefined;
  let stopped = false;

  function currentSourceSignature() {
    return JSON.stringify([toValue(baseURL), options.query ? toValue(options.query) : undefined]);
  }

  const resource = useInvocationResource<AgentInvocationListResult>({
    apply(result) {
      if (resetFirstPage || invocations.value.length === 0) {
        invocations.value = result.invocations;
        cursor.value = result.cursor;
        firstPage = result.invocations;
        resetFirstPage = false;
        return;
      }
      const firstPageIds = new Set(result.invocations.map((invocation) => invocation.id));
      const retained = invocations.value.filter(
        (invocation) => !firstPageIds.has(invocation.id) && !departedIds.has(invocation.id),
      );
      departedIds = new Set();
      invocations.value = [...result.invocations, ...retained];
      firstPage = result.invocations;
      if (retained.length === 0) cursor.value = result.cursor;
    },
    clear() {
      invocations.value = [];
      cursor.value = undefined;
      firstPage = [];
      pendingDepartureIds = new Set();
    },
    beforeLoad() {
      const nextSignature = currentSourceSignature();
      resetFirstPage = sourceSignature !== nextSignature;
      sourceSignature = nextSignature;
      if (resetFirstPage) {
        invocations.value = [];
        cursor.value = undefined;
        pendingDepartureIds = new Set();
      }
      revision++;
      loadMoreController?.abort();
      loadMoreController = undefined;
      isLoadingMore.value = false;
    },
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    load: async (signal) => {
      const query = options.query ? toValue(options.query) : undefined;
      const result = parseInvocationListResult(
        await request(appendQuery(toValue(baseURL), query), { signal }),
      );
      const requestedStatuses = Array.isArray(query?.status) ? query.status : [query?.status];
      const statuses = new Set(requestedStatuses.filter(isInvocationStatus));
      const search = query?.search?.trim().toLowerCase();
      if (resetFirstPage || (statuses.size === 0 && !search)) return result;
      const returnedIds = new Set(result.invocations.map((invocation) => invocation.id));
      for (const id of returnedIds) pendingDepartureIds.delete(id);
      const displaced = [
        ...new Set([
          ...firstPage
            .filter((invocation) => !returnedIds.has(invocation.id))
            .map((invocation) => invocation.id),
          ...pendingDepartureIds,
        ]),
      ];
      const reconciled = await Promise.allSettled(
        displaced.map((id) =>
          request(detailPath(toValue(baseURL), id), { signal }).then(parseInvocationDetailResult),
        ),
      );
      departedIds = new Set();
      pendingDepartureIds = new Set();
      for (const [index, outcome] of reconciled.entries()) {
        const id = displaced[index]!;
        if (outcome.status === "rejected") {
          pendingDepartureIds.add(id);
          continue;
        }
        const { observations: _observations, ...searchableInvocation } = outcome.value
          .invocation as AgentInvocationSummary & { observations?: unknown };
        if (
          (statuses.size > 0 && !statuses.has(outcome.value.invocation.status)) ||
          (search && !JSON.stringify(searchableInvocation).toLowerCase().includes(search))
        )
          departedIds.add(id);
      }
      return result;
    },
    pollingPaused: () => isLoadingMore.value,
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), options.query ? toValue(options.query) : undefined],
    watch: options.watch !== false,
  });

  async function loadMore(): Promise<AgentInvocationListResult | undefined> {
    if (stopped || resource.isLoading.value) return;
    const nextCursor = cursor.value;
    if (!nextCursor) return;
    loadMoreController?.abort();
    const controller = new AbortController();
    const currentRevision = revision;
    loadMoreController = controller;
    isLoadingMore.value = true;
    resource.error.value = null;
    try {
      const query = options.query ? toValue(options.query) : undefined;
      const result = parseInvocationListResult(
        await request(appendQuery(toValue(baseURL), { ...query, cursor: nextCursor }), {
          signal: controller.signal,
        }),
      );
      if (loadMoreController !== controller || revision !== currentRevision) return;
      const ids = new Set(invocations.value.map((invocation) => invocation.id));
      invocations.value = [
        ...invocations.value,
        ...result.invocations.filter((invocation) => !ids.has(invocation.id)),
      ];
      cursor.value = result.cursor;
      return result;
    } catch (cause) {
      if (loadMoreController !== controller || isAbortError(cause)) return;
      resource.error.value = cause;
    } finally {
      if (loadMoreController === controller) {
        loadMoreController = undefined;
        isLoadingMore.value = false;
        resource.schedule();
      }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    revision++;
    loadMoreController?.abort();
    loadMoreController = undefined;
    isLoadingMore.value = false;
    resource.stop();
  }

  onScopeDispose(() => loadMoreController?.abort(), true);
  return {
    cursor,
    error: resource.error,
    invocations,
    isLoading: resource.isLoading,
    isLoadingMore,
    loadMore,
    refresh: resource.refresh,
    stop,
  };
}

export function useAgentInvocation(
  id: MaybeRefOrGetter<string | undefined>,
  options: UseAgentInvocationOptions,
): UseAgentInvocationReturn {
  const invocation = shallowRef<AgentInvocationSummary | null>(null);
  const observations = shallowRef<readonly TraceEventLogEntry[]>([]);
  const request = options.request;
  const baseURL = options.baseURL ?? defaultBaseURL;

  const resource = useInvocationResource<AgentInvocationDetailResult>({
    apply(result) {
      invocation.value = result.invocation;
      observations.value = result.observations;
    },
    clear() {
      invocation.value = null;
      observations.value = [];
    },
    beforeSourceChange() {
      invocation.value = null;
      observations.value = [];
    },
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    load(signal) {
      const resolvedId = toValue(id);
      if (resolvedId === undefined) return Promise.resolve(undefined);
      return request(detailPath(toValue(baseURL), resolvedId), { signal }).then(
        parseInvocationDetailResult,
      );
    },
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), toValue(id)],
    watch: options.watch !== false,
  });

  return {
    error: resource.error,
    invocation,
    isLoading: resource.isLoading,
    observations,
    refresh: resource.refresh,
    stop: resource.stop,
  };
}
