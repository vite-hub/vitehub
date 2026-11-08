import type { StreamEvent } from "../messages.ts"
import type { RunAgentOptions } from "../index.ts"
import type {
  AgentCapabilityDefinition,
  AgentDataCarrier,
  AgentInput,
  AgentRunInput,
  AgentRunInputContextValues,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeContextInput,
  AgentToolSet,
} from "../types.ts"

export interface RunAgentInlineOptions {
  capabilities?: readonly AgentCapabilityDefinition[]
  output?: "raw" | "rendered"
  tools?: AgentToolSet
}

/** Runs an Agent in this process with a host Runtime Context. Returns the raw output and throws failures. */
export interface RunAgentInline {
  <TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown, TOutput = unknown, TData = unknown>(
    agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
    context: AgentRuntimeContextInput<TRuntimeConfig>,
    input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
    options: { output: "raw" },
  ): Promise<unknown>
  <TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown, TOutput = unknown, TData = unknown>(
    agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
    context: AgentRuntimeContextInput<TRuntimeConfig>,
    input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
    options?: RunAgentInlineOptions,
  ): Promise<TOutput | Response>
}

/** Streams an Agent in this process with a host Runtime Context. Throws failures before the stream starts. */
export type StreamAgentInline = <TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown, TData = unknown>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>> & AgentDataCarrier<TData>,
  context: AgentRuntimeContextInput<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options?: { output?: "events" | "ui-message-stream" },
) => Promise<Response | ReadableStream<unknown> | AsyncIterable<StreamEvent> | unknown>

/**
 * Runs an Agent with a host Runtime Context, as the generated Agent routes do. It starts a Workflow when the Agent
 * runtime selects one and returns its Workflow Run. Otherwise it returns the raw output. It throws failures.
 */
export type RunAgentWithContext = <TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown, TOutput = unknown, TData = unknown>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>, TOutput> & AgentDataCarrier<TData>,
  context: AgentRuntimeContextInput<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, AgentRunInputContextValues, NoInfer<TData>>,
  options?: Omit<RunAgentOptions, "runtimeContext"> & { output?: "drained" },
) => Promise<unknown>

export interface AgentRunners {
  runAgentInline: RunAgentInline
  runAgentWithContext: RunAgentWithContext
  streamAgentInline: StreamAgentInline
}

function notLoaded(): never {
  throw new Error("[vitehub] Import @vite-hub/agent before its internal Agent runners.")
}

// The root entry of @vite-hub/agent installs these runners when it loads. Every module that calls them also
// imports the root entry, so the runners are installed before the first call. They are not public exports.
export let runAgentInline: RunAgentInline = notLoaded
export let runAgentWithContext: RunAgentWithContext = notLoaded
export let streamAgentInline: StreamAgentInline = notLoaded

export function installAgentRunners(runners: AgentRunners): void {
  ({ runAgentInline, runAgentWithContext, streamAgentInline } = runners)
}
