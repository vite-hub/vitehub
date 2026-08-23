import { onScopeDispose, shallowRef, toValue, watch } from "vue";

import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import type {
  AgentInvocationListResult,
  AgentInvocationRecordStatus,
  AgentInvocationSummary,
} from "./invocations.ts";

export interface AgentInvocationRequestOptions {
  signal?: AbortSignal;
}

export type AgentInvocationRequester = (
  path: string,
  options: AgentInvocationRequestOptions,
) => Promise<unknown>;

type QueryValue = boolean | number | string | null | undefined;
type AgentInvocationQuery = Record<string, QueryValue | readonly QueryValue[]> & { search?: string };

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
const retainedReconciliationLimit = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInvocationStatus(value: unknown): value is AgentInvocationRecordStatus {
  return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function isTraceEventType(value: unknown): value is TraceEventLogEntry["type"] {
  return value === "approval" || value === "capability" || value === "error" || value === "lifecycle" || value === "policy" || value === "run";
}

function parseInvocationSummary(value: unknown): AgentInvocationSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.cursor !== "string" ||
    !isInvocationStatus(value.status) ||
    typeof value.traceId !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new TypeError("Invalid Agent Invocation response.");
  }
  return {
    ...value,
    createdAt: value.createdAt,
    cursor: value.cursor,
    id: value.id,
    status: value.status,
    traceId: value.traceId,
    updatedAt: value.updatedAt,
  };
}

function parseInvocationListResult(value: unknown): AgentInvocationListResult {
  if (!isRecord(value) || !Array.isArray(value.invocations)) {
    throw new TypeError("Invalid Agent Invocation list response.");
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw new TypeError("Invalid Agent Invocation list cursor.");
  }
  return {
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    invocations: value.invocations.map(parseInvocationSummary),
  };
}

function parseAgentInvocationDetailResult(value: unknown): AgentInvocationDetailResult {
  if (!isRecord(value) || !Array.isArray(value.observations)) {
    throw new TypeError("Invalid Agent Invocation detail response.");
  }
  const observations = value.observations.map((observation) => {
    if (
      !isRecord(observation) ||
      typeof observation.name !== "string" ||
      typeof observation.sequence !== "number" ||
      typeof observation.timestamp !== "string" ||
      !isTraceEventType(observation.type)
    ) {
      throw new TypeError("Invalid Agent Invocation observation.");
    }
    return {
      ...observation,
      name: observation.name,
      sequence: observation.sequence,
      timestamp: observation.timestamp,
      type: observation.type,
    };
  });
  return { invocation: parseInvocationSummary(value.invocation), observations };
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "name" in error && error.name === "AbortError",
  );
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
  clear: () => void;
  immediate: boolean;
  load: (signal: AbortSignal) => Promise<T | undefined>;
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

  return { error, isLoading, refresh, stop };
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
  let revision = 0;
  let reconciliationOffset = 0;
  let reconciliationRetryIds = new Set<string>();
  let resetFirstPage = true;
  let departedIds = new Set<string>();
  let reconciledInvocations = new Map<string, AgentInvocationSummary>();
  let sourceSignature: string | undefined;
  let stopped = false;

  function currentSourceSignature() {
    return JSON.stringify([
      toValue(baseURL),
      options.query ? toValue(options.query) : undefined,
    ]);
  }

  const resource = useInvocationResource<AgentInvocationListResult>({
    apply(result) {
      if (resetFirstPage || invocations.value.length === 0) {
        invocations.value = result.invocations;
        cursor.value = result.cursor;
        resetFirstPage = false;
        return;
      }
      const firstPageIds = new Set(result.invocations.map(invocation => invocation.id));
      const retained = invocations.value
        .filter(invocation => !firstPageIds.has(invocation.id) && !departedIds.has(invocation.id))
        .map(invocation => reconciledInvocations.get(invocation.id) ?? invocation);
      departedIds = new Set();
      reconciledInvocations = new Map();
      invocations.value = [...result.invocations, ...retained];
      if (retained.length === 0) cursor.value = result.cursor;
    },
    clear() {
      invocations.value = [];
      cursor.value = undefined;
      reconciledInvocations = new Map();
      reconciliationRetryIds = new Set();
    },
    beforeLoad() {
      const nextSignature = currentSourceSignature();
      resetFirstPage = sourceSignature !== nextSignature;
      sourceSignature = nextSignature;
      if (resetFirstPage) {
        invocations.value = [];
        cursor.value = undefined;
        reconciliationOffset = 0;
        reconciliationRetryIds = new Set();
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
      if (resetFirstPage) return result;
      const returnedIds = new Set(result.invocations.map(invocation => invocation.id));
      for (const id of returnedIds) reconciliationRetryIds.delete(id);
      const retainedIds = invocations.value
        .filter(invocation => !returnedIds.has(invocation.id))
        .map(invocation => invocation.id);
      const retainedIdSet = new Set(retainedIds);
      const retryCandidates = [...reconciliationRetryIds]
        .filter(id => retainedIdSet.has(id));
      const retryLimit = retainedIds.some(id => !reconciliationRetryIds.has(id))
        ? Math.floor(retainedReconciliationLimit / 2)
        : retainedReconciliationLimit;
      const retries = retryCandidates.slice(0, retryLimit);
      const retryCandidateSet = new Set(retryCandidates);
      const rotatingIds = retainedIds.filter(id => !retryCandidateSet.has(id));
      const rotatingCount = Math.min(
        rotatingIds.length,
        retainedReconciliationLimit - retries.length,
      );
      const rotating = Array.from({ length: rotatingCount }, (_, index) =>
        rotatingIds[(reconciliationOffset + index) % rotatingIds.length],
      ).filter((id): id is string => id !== undefined);
      const displaced = [...retries, ...rotating];
      reconciliationOffset = rotatingIds.length === 0
        ? 0
        : (reconciliationOffset + rotatingCount) % rotatingIds.length;
      const reconciled = await Promise.allSettled(displaced.map(id =>
        request(detailPath(toValue(baseURL), id), { signal }).then(parseAgentInvocationDetailResult),
      ));
      departedIds = new Set();
      reconciledInvocations = new Map();
      for (const [index, outcome] of reconciled.entries()) {
        const id = displaced[index];
        if (!id) continue;
        if (outcome.status === "rejected") {
          reconciliationRetryIds.add(id);
          continue;
        }
        reconciliationRetryIds.delete(id);
        // SAFETY: The detail parser has validated the invocation summary fields; observations are the only detail-only field removed here.
        const { observations: _observations, ...searchableInvocation } = outcome.value.invocation as AgentInvocationSummary & { observations?: unknown };
        if (
          (statuses.size > 0 && !statuses.has(outcome.value.invocation.status))
          || (search && !JSON.stringify(searchableInvocation).toLowerCase().includes(search))
        ) departedIds.add(id);
        else reconciledInvocations.set(id, searchableInvocation);
      }
      return result;
    },
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
        await request(
          appendQuery(toValue(baseURL), { ...query, cursor: nextCursor }),
          { signal: controller.signal },
        ),
      );
      if (loadMoreController !== controller || revision !== currentRevision) return;
      const ids = new Set(invocations.value.map(invocation => invocation.id));
      invocations.value = [
        ...invocations.value,
        ...result.invocations.filter(invocation => !ids.has(invocation.id)),
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
  return { cursor, invocations, isLoadingMore, loadMore, ...resource, stop };
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
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    load(signal) {
      const resolvedId = toValue(id);
      if (resolvedId === undefined) return Promise.resolve(undefined);
      return request(detailPath(toValue(baseURL), resolvedId), { signal }).then(
        parseAgentInvocationDetailResult,
      );
    },
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), toValue(id)],
    watch: options.watch !== false,
  });

  return { invocation, observations, ...resource };
}
