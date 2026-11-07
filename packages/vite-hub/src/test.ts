import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { DeliverChannelOptions, deliverChannel as deliverAgentChannel } from "@vite-hub/agent/test"
import type { EmailMessage } from "@vite-hub/email"

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

export interface ViteHubTest {
  /** Messages that `email.send()` accepted during the current test. No provider runs. */
  readonly emails: readonly EmailMessage[]
  /** Jobs that `runQueue()`, `deferQueue()`, and Queue clients sent during the current test. No handler runs. */
  readonly jobs: readonly ViteHubTestJob[]
  /**
   * Sends one webhook delivery to a Channel of an Agent, as the provider would, and waits for the work that it starts.
   * Pass the header that the Channel checks, such as `x-telegram-bot-api-secret-token`, in `options.headers`.
   */
  deliverChannel: (...input: Parameters<typeof deliverAgentChannel>) => Promise<Response>
  /** Empties every in-memory backend and clears the `setEnv()` values. Call it in `beforeEach`. */
  reset: () => Promise<void>
  /** Sets Server Env values until the next reset. `undefined` removes a value. They win over `process.env`. */
  setEnv: (values: Record<string, string | undefined>) => void
}

/**
 * Turns on test mode for this test file. KV, Blob, Database, Queue, Email, and Rate Limit then use local backends that
 * `reset()` empties, so a test runs the app's own server code with no mocks and no provider account.
 */
export function setupViteHubTest(options: ViteHubTestOptions = {}): ViteHubTest {
  const mode = enableViteHubTestMode(options)
  return {
    // Email and Queue store their test state under these keys in test mode.
    get emails() { return mode.peek<{ messages: EmailMessage[] }>("email")?.messages ?? [] },
    get jobs() { return mode.peek<ViteHubTestJob[]>("queue") ?? [] },
    async deliverChannel(...input) {
      // Only a test that drives an Agent loads the Agent package.
      const { deliverChannel } = await import("@vite-hub/agent/test")
      return await deliverChannel(...input)
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
