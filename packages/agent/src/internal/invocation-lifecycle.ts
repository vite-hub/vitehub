export interface AgentInvocationLifecycle<Outcome> {
  fail: (outcome: Outcome, error: unknown, message: string) => Promise<never>
  finish: (outcome: Outcome) => Promise<void>
}

/**
 * Runs `finish` one time with the first outcome that `finish()` or `fail()` receives.
 * Later calls wait for the same completion.
 */
export function openAgentInvocationLifecycle<Outcome>(
  finish: (outcome: Outcome) => Promise<void>,
): AgentInvocationLifecycle<Outcome> {
  let completion: Promise<void> | undefined

  function complete(outcome: Outcome): { completion: Promise<void>, started: boolean } {
    if (completion) return { completion, started: false }
    completion = (async () => await finish(outcome))()
    return { completion, started: true }
  }

  return {
    async fail(outcome, error, message) {
      const { completion, started } = complete(outcome)
      try {
        await completion
      }
      catch (finishError) {
        if (started) throw new AggregateError([error, finishError], message)
      }
      throw error
    },
    async finish(outcome) {
      await complete(outcome).completion
    },
  }
}
