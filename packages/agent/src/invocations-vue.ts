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
  onSuccess?: () => void;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  query?: MaybeRefOrGetter<AgentInvocationQuery>;
  request: AgentInvocationRequester;
  requestSummaries?: AgentInvocationRequester;
  watch?: boolean;
}

export interface UseAgentInvocationsReturn {
  cursor: ShallowRef<string | undefined>;
  error: ShallowRef<unknown>;
  invocations: ShallowRef<readonly AgentInvocationSummary[]>;
  isLoading: ShallowRef<boolean>;
  isLoadingMore: ShallowRef<boolean>;
  loadMoreError: ShallowRef<unknown>;
  remainingStatuses: ShallowRef<readonly AgentInvocationRecordStatus[]>;
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
  onSuccess?: () => void;
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
const maximumPaginationRequestsPerLoad = 2;
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
  if (value.remainingStatuses !== undefined && (!Array.isArray(value.remainingStatuses)
    || !value.remainingStatuses.every(isInvocationStatus))) {
    throw new TypeError("Invalid Agent Invocation remaining statuses.");
  }
  return {
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    invocations: value.invocations.map(parseInvocationSummary),
    ...(Array.isArray(value.remainingStatuses) ? { remainingStatuses: value.remainingStatuses.filter(isInvocationStatus) } : {}),
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
  canPoll?: () => boolean;
  clear: () => void;
  immediate: boolean;
  load: (signal: AbortSignal) => Promise<T | undefined>;
  onSuccess?: () => void;
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
      if (options.canPoll && !options.canPoll()) {
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
      else {
        options.apply(result);
        options.onSuccess?.();
      }
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
  type ReconciledInvocationListResult = AgentInvocationListResult & {
    departedIds?: ReadonlySet<string>
    pendingDepartureIds?: ReadonlySet<string>
    reconciledInvocations?: ReadonlyMap<string, AgentInvocationSummary>
  }
  const invocations = shallowRef<readonly AgentInvocationSummary[]>([]);
  const cursor = shallowRef<string | undefined>();
  const isLoadingMore = shallowRef(false);
  const loadMoreError = shallowRef<unknown>(null);
  const remainingStatuses = shallowRef<readonly AgentInvocationRecordStatus[]>([]);
  const request = options.request;
  const baseURL = options.baseURL ?? defaultBaseURL;
  let loadMoreController: AbortController | undefined;
  let firstPageCursor: string | undefined;
  let paginationCursor: string | undefined;
  let paginationStarted = false;
  let revision = 0;
  let reconciliationOffset = 0;
  let resetFirstPage = true;
  let pendingDepartureIds = new Set<string>();
  let sourceSignature: string | undefined;
  let stopped = false;

  function currentSourceSignature() {
    return JSON.stringify([
      toValue(baseURL),
      options.query ? toValue(options.query) : undefined,
    ]);
  }

  const resource = useInvocationResource<ReconciledInvocationListResult>({
    apply(result) {
      if (resetFirstPage || invocations.value.length === 0) {
        invocations.value = result.invocations;
        cursor.value = result.cursor;
        firstPageCursor = result.cursor;
        paginationCursor = result.cursor;
        paginationStarted = false;
        remainingStatuses.value = result.remainingStatuses ?? [];
        resetFirstPage = false;
        return;
      }
      const departedIds = result.departedIds ?? new Set<string>();
      const reconciledInvocations = result.reconciledInvocations ?? new Map<string, AgentInvocationSummary>();
      const firstPageIds = new Set(result.invocations.map(invocation => invocation.id));
      const retained = invocations.value
        .filter(invocation => !firstPageIds.has(invocation.id) && !departedIds.has(invocation.id))
        .map(invocation => reconciledInvocations.get(invocation.id) ?? invocation);
      pendingDepartureIds = new Set(result.pendingDepartureIds ?? pendingDepartureIds);
      invocations.value = [...result.invocations, ...retained];
      if (result.cursor !== firstPageCursor) {
        firstPageCursor = result.cursor;
        paginationCursor = result.cursor;
        paginationStarted = false;
      }
      cursor.value = paginationStarted ? paginationCursor : result.cursor;
      remainingStatuses.value = result.remainingStatuses ?? [];
    },
    clear() {
      invocations.value = [];
      cursor.value = undefined;
      remainingStatuses.value = [];
      pendingDepartureIds = new Set();
    },
    beforeLoad() {
      const nextSignature = currentSourceSignature();
      resetFirstPage = sourceSignature !== nextSignature;
      sourceSignature = nextSignature;
      if (resetFirstPage) {
        invocations.value = [];
        cursor.value = undefined;
        firstPageCursor = undefined;
        paginationCursor = undefined;
        paginationStarted = false;
        reconciliationOffset = 0;
        loadMoreError.value = null;
      }
      revision++;
      if (loadMoreController && !resetFirstPage) {
        loadMoreError.value = new Error("Loading older Agent Invocations was interrupted.");
      }
      loadMoreController?.abort();
      loadMoreController = undefined;
      isLoadingMore.value = false;
    },
    canPoll: () => !isLoadingMore.value,
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    load: async (signal) => {
      const query = options.query ? toValue(options.query) : undefined;
      const result = parseInvocationListResult(
        await request(appendQuery(toValue(baseURL), query), { signal }),
      );
      const returnedIds = new Set(result.invocations.map(invocation => invocation.id));
      const requestedStatuses = Array.isArray(query?.status) ? query.status : [query?.status];
      const statuses = new Set(requestedStatuses.filter(isInvocationStatus));
      const search = query?.search?.trim().toLowerCase();
      const retainedIds = resetFirstPage
        ? []
        : invocations.value
            .filter(invocation => !returnedIds.has(invocation.id))
            .map(invocation => invocation.id);
      if (options.requestSummaries && statuses.size === 0 && !search && retainedIds.length > 0) {
        const requestSummaries = options.requestSummaries;
        const reconciliationCount = Math.min(retainedIds.length, retainedReconciliationLimit);
        const selectedRetainedIds = Array.from({ length: reconciliationCount }, (_, index) =>
          retainedIds[(reconciliationOffset + index) % retainedIds.length],
        ).filter((id): id is string => id !== undefined);
        reconciliationOffset = (reconciliationOffset + reconciliationCount) % retainedIds.length;
        const summary = parseInvocationListResult(await requestSummaries(
          appendQuery(toValue(baseURL), { id: selectedRetainedIds }),
          { signal },
        ));
        const refreshed = new Map(summary.invocations.map(invocation => [invocation.id, invocation]));
        const departedIds = new Set<string>();
        const reconciledInvocations = new Map<string, AgentInvocationSummary>();
        for (const id of selectedRetainedIds) {
          const summary = refreshed.get(id);
          if (summary) reconciledInvocations.set(id, summary);
          else departedIds.add(id);
        }
        return { ...result, departedIds, reconciledInvocations };
      }
      if (resetFirstPage || (statuses.size === 0 && !search)) return result;
      const nextPendingDepartureIds = new Set(pendingDepartureIds);
      for (const id of returnedIds) nextPendingDepartureIds.delete(id);
      const reconciliationCount = Math.min(retainedIds.length, retainedReconciliationLimit);
      const selectedRetainedIds = Array.from({ length: reconciliationCount }, (_, index) =>
        retainedIds[(reconciliationOffset + index) % retainedIds.length],
      ).filter((id): id is string => id !== undefined);
      reconciliationOffset = retainedIds.length === 0
        ? 0
        : (reconciliationOffset + reconciliationCount) % retainedIds.length;
      const displaced = [...new Set([
        ...selectedRetainedIds,
        ...nextPendingDepartureIds,
      ])].slice(0, retainedReconciliationLimit);
      const reconciled = await Promise.allSettled(displaced.map(id =>
        request(detailPath(toValue(baseURL), id), { signal }).then(parseAgentInvocationDetailResult),
      ));
      const departedIds = new Set<string>();
      const reconciledInvocations = new Map<string, AgentInvocationSummary>();
      nextPendingDepartureIds.clear();
      for (const [index, outcome] of reconciled.entries()) {
        const id = displaced[index];
        if (!id) continue;
        if (outcome.status === "rejected") {
          nextPendingDepartureIds.add(id);
          continue;
        }
        // SAFETY: The detail parser has validated the invocation summary fields; observations are the only detail-only field removed here.
        const { observations: _observations, ...searchableInvocation } = outcome.value.invocation as AgentInvocationSummary & { observations?: unknown };
        if (
          (statuses.size > 0 && !statuses.has(outcome.value.invocation.status))
          || (search && !JSON.stringify(searchableInvocation).toLowerCase().includes(search))
        ) departedIds.add(id);
        else reconciledInvocations.set(id, searchableInvocation);
      }
      return { ...result, departedIds, pendingDepartureIds: nextPendingDepartureIds, reconciledInvocations };
    },
    onSuccess: options.onSuccess,
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), options.query ? toValue(options.query) : undefined],
    watch: options.watch !== false,
  });

  async function loadMore(): Promise<AgentInvocationListResult | undefined> {
    if (stopped || resource.isLoading.value) return;
    let nextCursor = paginationCursor;
    if (!nextCursor) return;
    loadMoreController?.abort();
    const controller = new AbortController();
    const currentRevision = revision;
    loadMoreController = controller;
    isLoadingMore.value = true;
    resource.error.value = null;
    try {
      const query = options.query ? toValue(options.query) : undefined;
      const visited = new Set<string>();
      while (nextCursor && !visited.has(nextCursor)) {
        visited.add(nextCursor);
        const result = parseInvocationListResult(
          await request(
            appendQuery(toValue(baseURL), { ...query, cursor: nextCursor }),
            { signal: controller.signal },
          ),
        );
        if (loadMoreController !== controller || revision !== currentRevision) return;
        const updates = new Map(result.invocations.map(invocation => [invocation.id, invocation]));
        const retainedIds = new Set(invocations.value.map(invocation => invocation.id));
        const additions = [...updates.values()].filter(invocation => !retainedIds.has(invocation.id));
        if (updates.size > 0) {
          invocations.value = [
            ...invocations.value.map(invocation => updates.get(invocation.id) ?? invocation),
            ...additions,
          ];
        }
        paginationStarted = true;
        paginationCursor = result.cursor;
        cursor.value = paginationCursor;
        remainingStatuses.value = result.remainingStatuses ?? [];
        loadMoreError.value = null;
        if (additions.length > 0 || !result.cursor || visited.size >= maximumPaginationRequestsPerLoad) return result;
        nextCursor = result.cursor;
      }
    } catch (cause) {
      if (loadMoreController !== controller || isAbortError(cause)) return;
      loadMoreError.value = cause;
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
  return { cursor, invocations, isLoadingMore, loadMore, loadMoreError, remainingStatuses, ...resource, stop };
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
    onSuccess: options.onSuccess,
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), toValue(id)],
    watch: options.watch !== false,
  });

  return { invocation, observations, ...resource };
}
