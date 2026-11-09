import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"

import type { DeliverChannelOptions, TestEmailMessage, TestScheduleDefinition, TestScheduleRunRecord } from "./internal/test-types.ts"

export type { DeliverChannelOptions }

export interface ViteHubTestOptions {
  /** The app folder that has `server/`. Database reads its migrations from there. Defaults to the current folder. */
  root?: string
}

/** One Queue job that the app sent during the current test. */
export interface ViteHubTestJob {
  id: string
  options: Record<string, unknown>
  payload: unknown
  queue: string
}

/** One Workflow run that the app started during the current test. */
export interface ViteHubTestWorkflowRun {
  deferred: boolean
  id: string
  payload: unknown
  status: "queued" | "cancelled"
  workflow: string
}

export interface RunScheduleTestOptions {
  /** The Schedule name in the run record. Defaults to `schedule`. */
  name?: string
  /** The time the handler receives as `scheduledAt`, as if the cron fired then. Defaults to now. */
  scheduledAt?: Date
}

export interface ViteHubTest {
  /** Messages that `email.send()` accepted during the current test. No provider runs. */
  readonly emails: readonly TestEmailMessage[]
  /** Jobs that `runQueue()`, `deferQueue()`, and Queue clients sent during the current test. No handler runs. */
  readonly jobs: readonly ViteHubTestJob[]
  /** Runs that `runWorkflow()`, `deferWorkflow()`, and Workflow handles started during the current test. No handler runs. */
  readonly workflows: readonly ViteHubTestWorkflowRun[]
  /**
   * Sends one webhook delivery to a Channel of an Agent, as the provider would, and waits for the work that it starts.
   * Pass the header that the Channel checks, such as `x-telegram-bot-api-secret-token`, in `options.headers`.
   */
  deliverChannel: (agent: { resolve: (...args: never[]) => unknown }, channel: string, body: unknown, options?: DeliverChannelOptions) => Promise<Response>
  /**
   * Runs a Schedule Definition once, as its cron would, and waits for the work that it starts with `waitUntil()`.
   * Returns the run record. A handler error rejects the promise.
   */
  runSchedule: (definition: TestScheduleDefinition, options?: RunScheduleTestOptions) => Promise<TestScheduleRunRecord>
  /** Empties every in-memory backend and clears the `setEnv()` values. Call it in `beforeEach`. */
  reset: () => Promise<void>
  /** Sets Server Env values until the next reset. `undefined` removes a value. They win over `process.env`. */
  setEnv: (values: Record<string, string | undefined>) => void
}

/**
 * Turns on test mode for this test file. KV, Blob, Database, Queue, Workflow, Email, and Rate Limit then use local backends that
 * `reset()` empties, so a test runs the app's own server code with no mocks and no provider account.
 */
export function setupViteHubTest(options: ViteHubTestOptions = {}): ViteHubTest {
  const mode = enableViteHubTestMode(options)
  let scheduleRuns = 0
  return {
    // Email and Queue store their test state under these keys in test mode.
    get emails() { return mode.peek<{ messages: TestEmailMessage[] }>("email")?.messages ?? [] },
    get jobs() { return mode.peek<ViteHubTestJob[]>("queue") ?? [] },
    get workflows() { return mode.peek<ViteHubTestWorkflowRun[]>("workflow") ?? [] },
    async deliverChannel(agent, channel, body, options) {
      // Only a test that drives an Agent loads the Agent package.
      const { deliverChannel } = await import("@vite-hub/agent/test")
      // SAFETY: Accept the Agent's structural entry without importing its optional declarations into the facade.
      return await deliverChannel(agent as Parameters<typeof deliverChannel>[0], channel, body, options)
    },
    async runSchedule(definition, options = {}) {
      // Only a test that runs a Schedule loads the Schedule package.
      const { createMemoryScheduleRunStore, executeSchedule } = await import("@vite-hub/schedule/runtime")
      const name = options.name ?? "schedule"
      // Each call is its own run, so a test can run the same occurrence twice.
      const runIdSuffix = `test${++scheduleRuns}`
      return await executeSchedule({
        definition,
        runIdSuffix,
        runStore: mode.backend("schedule", createMemoryScheduleRunStore),
        scheduleId: name,
        source: "manual",
        ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
        target: name,
      })
    },
    reset: () => mode.reset(),
    setEnv(values) {
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete mode.env[name]
        else mode.env[name] = value
      }
    },
  }
}
