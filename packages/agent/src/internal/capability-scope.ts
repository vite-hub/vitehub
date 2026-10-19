import type { MaybePromise } from "../types.ts"

const closeFailedMessage = "[vitehub] Multiple capability close callbacks failed."

/**
 * Owns the close callbacks of resolved Capabilities.
 *
 * `close()` runs each callback one time, in reverse registration order, and runs
 * all callbacks even when one fails. A callback added after `close()` runs at once.
 */
export class AgentCapabilityScope {
  private readonly callbacks: Array<() => MaybePromise<void>> = []
  private readonly failures: unknown[] = []
  private closing: Promise<void> | undefined

  async add(close: () => MaybePromise<void>): Promise<void> {
    if (this.closing) await this.runCallback(close)
    else this.callbacks.push(close)
  }

  async close(): Promise<void> {
    this.closing ??= this.runCallbacks()
    await this.closing
    if (this.failures.length === 1) throw this.failures[0]
    if (this.failures.length > 1) throw new AggregateError([...this.failures], closeFailedMessage)
  }

  async failSetup(error: unknown): Promise<never> {
    try {
      await this.close()
    }
    catch (closeError) {
      throw new AggregateError([error, closeError], "[vitehub] Capability setup failed and cleanup also failed.")
    }
    throw error
  }

  private async runCallbacks(): Promise<void> {
    for (const callback of this.callbacks.splice(0).reverse()) await this.runCallback(callback)
  }

  private async runCallback(callback: () => MaybePromise<void>): Promise<void> {
    try {
      await callback()
    }
    catch (error) {
      this.failures.push(error)
    }
  }
}
