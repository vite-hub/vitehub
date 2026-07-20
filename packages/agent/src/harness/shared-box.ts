import type { Box, BoxOpenOptions, BoxSession } from "@vite-hub/box"

export const harnessBoxOpen = Symbol("vitehub.agent.harness-box-open")
const harnessBoxActive = Symbol("vitehub.agent.harness-box-active")

export type SharedHarnessBox = Box & {
  [harnessBoxActive](): boolean
  [harnessBoxOpen](options?: BoxOpenOptions): Promise<BoxSession>
}

export function isHarnessBoxActive(box: Box) {
  return (box as Partial<SharedHarnessBox>)[harnessBoxActive]?.() ?? false
}

export async function openHarnessBox(box: Box, options?: BoxOpenOptions) {
  const shared = box as Partial<SharedHarnessBox>
  return shared[harnessBoxOpen]
    ? await shared[harnessBoxOpen](options)
    : await box.open(options)
}

export function shareBoxSessions(box: Box): SharedHarnessBox {
  let active: Promise<BoxSession> | undefined
  let harnessActive = false
  let initializing: BoxSession | undefined
  let leases = 0
  const lease = (session: BoxSession) => {
    leases++
    let closed = false
    return {
      ...session,
      async close() {
        if (closed) return
        closed = true
        leases--
        if (leases === 0) {
          const current = active
          active = undefined
          harnessActive = false
          if (current) await (await current).close()
        }
      },
    }
  }
  return {
    plan: box.plan,
    [harnessBoxActive]() {
      return harnessActive
    },
    async open(options) {
      if (initializing) {
        options?.signal?.throwIfAborted()
        return lease(initializing)
      }
      await Promise.resolve()
      options?.signal?.throwIfAborted()
      active ||= box.open(options)
      try {
        return lease(await active)
      }
      catch (error) {
        active = undefined
        throw error
      }
    },
    async [harnessBoxOpen](options) {
      if (!active) {
        harnessActive = true
        let harnessLease: BoxSession | undefined
        active = box.open({
          ...options,
          ...(options?.initialize
            ? {
                async initialize(session, context) {
                  initializing = session
                  harnessLease = lease(session)
                  try {
                    await options.initialize!(harnessLease, context)
                  }
                  finally {
                    initializing = undefined
                  }
                },
              }
            : {}),
        })
        try {
          const session = await active
          return harnessLease || lease(session)
        }
        catch (error) {
          leases = 0
          harnessActive = false
          initializing = undefined
          active = undefined
          throw error
        }
      }
      return lease(await active)
    },
  }
}
