import { onScopeDispose, shallowRef, toValue, watch } from "vue";

import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import type {
  AgentInvocationListResult,
  AgentInvocationSummary,
} from "./invocations.ts";

export interface AgentInvocationRequestOptions {
  signal?: AbortSignal;
}

export type AgentInvocationRequester = <T>(
  path: string,
  options: AgentInvocationRequestOptions,
) => Promise<T>;

type QueryValue = boolean | number | string | null | undefined;

export interface UseAgentInvocationsOptions {
  baseURL?: MaybeRefOrGetter<string>;
  immediate?: boolean;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  query?: MaybeRefOrGetter<Record<string, QueryValue | readonly QueryValue[]>>;
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
  beforeSourceChange?: () => void;
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
  let loadedPages = 1;
  let revision = 0;
  let stopped = false;

  const resource = useInvocationResource<AgentInvocationListResult>({
    apply(result) {
      invocations.value = result.invocations;
      cursor.value = result.cursor;
    },
    clear() {
      loadedPages = 1;
      invocations.value = [];
      cursor.value = undefined;
    },
    beforeLoad() {
      revision++;
      loadMoreController?.abort();
      loadMoreController = undefined;
      isLoadingMore.value = false;
    },
    beforeSourceChange() {
      loadedPages = 1;
    },
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    async load(signal) {
      const query = options.query ? toValue(options.query) : undefined;
      const first = await request<AgentInvocationListResult>(
        appendQuery(toValue(baseURL), query),
        { signal },
      );
      const refreshed = [...first.invocations];
      let nextCursor = first.cursor;
      for (let page = 1; page < loadedPages && nextCursor; page++) {
        const next = await request<AgentInvocationListResult>(
          appendQuery(toValue(baseURL), { ...query, cursor: nextCursor }),
          { signal },
        );
        const ids = new Set(refreshed.map(invocation => invocation.id));
        refreshed.push(...next.invocations.filter(invocation => !ids.has(invocation.id)));
        nextCursor = next.cursor;
      }
      return { cursor: nextCursor, invocations: refreshed };
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
      const result = await request<AgentInvocationListResult>(
        appendQuery(toValue(baseURL), { ...query, cursor: nextCursor }),
        { signal: controller.signal },
      );
      if (loadMoreController !== controller || revision !== currentRevision) return;
      const ids = new Set(invocations.value.map(invocation => invocation.id));
      invocations.value = [
        ...invocations.value,
        ...result.invocations.filter(invocation => !ids.has(invocation.id)),
      ];
      loadedPages++;
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
      return request<AgentInvocationDetailResult>(detailPath(toValue(baseURL), resolvedId), {
        signal,
      });
    },
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), toValue(id)],
    watch: options.watch !== false,
  });

  return { invocation, observations, ...resource };
}
