import { onScopeDispose, shallowRef, toValue, watch } from "vue";

import type { TraceEventLogEntry } from "@vite-hub/runtime";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import type {
  AgentInvocationListResult,
  AgentInvocationRecord,
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
  request?: AgentInvocationRequester;
  watch?: boolean;
}

export interface UseAgentInvocationsReturn {
  cursor: ShallowRef<string | undefined>;
  error: ShallowRef<unknown>;
  invocations: ShallowRef<readonly AgentInvocationSummary[]>;
  isLoading: ShallowRef<boolean>;
  refresh: () => Promise<AgentInvocationListResult | undefined>;
  stop: () => void;
}

export interface AgentInvocationDetailResult {
  invocation: AgentInvocationRecord;
  observations: readonly TraceEventLogEntry[];
}

export interface UseAgentInvocationOptions {
  baseURL?: MaybeRefOrGetter<string>;
  immediate?: boolean;
  pollInterval?: MaybeRefOrGetter<false | number | undefined>;
  request?: AgentInvocationRequester;
  watch?: boolean;
}

export interface UseAgentInvocationReturn {
  error: ShallowRef<unknown>;
  invocation: ShallowRef<AgentInvocationRecord | null>;
  isLoading: ShallowRef<boolean>;
  observations: ShallowRef<readonly TraceEventLogEntry[]>;
  refresh: () => Promise<AgentInvocationDetailResult | undefined>;
  stop: () => void;
}

const defaultBaseURL = "/api/invocations";

const defaultRequester: AgentInvocationRequester = async <T>(
  path: string,
  options: AgentInvocationRequestOptions,
) => {
  const response = await fetch(path, { signal: options.signal });
  if (!response.ok)
    throw new Error(`Agent invocation request failed with status ${response.status}.`);
  return (await response.json()) as T;
};

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
  options: UseAgentInvocationsOptions = {},
): UseAgentInvocationsReturn {
  const invocations = shallowRef<readonly AgentInvocationSummary[]>([]);
  const cursor = shallowRef<string | undefined>();
  const request = options.request ?? defaultRequester;
  const baseURL = options.baseURL ?? defaultBaseURL;

  const resource = useInvocationResource<AgentInvocationListResult>({
    apply(result) {
      invocations.value = result.invocations;
      cursor.value = result.cursor;
    },
    clear() {
      invocations.value = [];
      cursor.value = undefined;
    },
    immediate:
      options.immediate !== false && (options.request !== undefined || "window" in globalThis),
    load: (signal) =>
      request<AgentInvocationListResult>(
        appendQuery(toValue(baseURL), options.query ? toValue(options.query) : undefined),
        { signal },
      ),
    pollInterval: options.pollInterval,
    source: () => [toValue(baseURL), options.query ? toValue(options.query) : undefined],
    watch: options.watch !== false,
  });

  return { cursor, invocations, ...resource };
}

export function useAgentInvocation(
  id: MaybeRefOrGetter<string | undefined>,
  options: UseAgentInvocationOptions = {},
): UseAgentInvocationReturn {
  const invocation = shallowRef<AgentInvocationRecord | null>(null);
  const observations = shallowRef<readonly TraceEventLogEntry[]>([]);
  const request = options.request ?? defaultRequester;
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
