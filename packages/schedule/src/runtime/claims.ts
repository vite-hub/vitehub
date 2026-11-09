import type { Lease, LeaseStore } from "@vite-hub/runtime"

export interface OccurrenceClaimsOptions {
  /**
   * Milliseconds after the end of a run that its done marker lasts. Make it longer than the catch-up window, so that a
   * process that starts later does not run the occurrence again.
   */
  doneTtlMs: number
  leases: LeaseStore
  /** A label for the holder, such as `host:pid`. It is for inspection only. */
  owner?: string
  reportError(error: unknown): void
  /** Milliseconds that a claim lasts when its process stops renewing it, for example after a crash. */
  ttlMs: number
}

/** `held` when another process holds the occurrence now, `done` when a process finished it, `ran` when this call ran it. */
export type OccurrenceClaimResult = "done" | "held" | "ran"

/** Runs each Schedule occurrence in one process of all the processes that share `leases`. */
export interface OccurrenceClaims {
  /**
   * Runs `run` when this process gets the claim on `runId` and no process finished it. While `run` works, the claim is
   * renewed. After `run`, a done marker stays for `doneTtlMs`, also when `run` throws: a failed run is final.
   */
  run(runId: string, run: () => Promise<unknown>): Promise<OccurrenceClaimResult>
}

const claimPrefix = "schedule/"

/** The lease key of one occurrence, such as `schedule/srun_static_daily_2026-11-09T08:00:00.000Z`. */
export function occurrenceLeaseKey(runId: string): string {
  return `${claimPrefix}${runId}`
}

/** The lease key that marks an occurrence as finished. */
export function occurrenceDoneKey(runId: string): string {
  return `${occurrenceLeaseKey(runId)}/done`
}

function keepAlive(lease: Lease, ttlMs: number, reportError: (error: unknown) => void): () => void {
  const timer = setInterval(() => {
    void lease.renew().then(([error, renewed]) => {
      if (error) reportError(error)
      else if (!renewed) reportError(new Error(`[vitehub] Schedule occurrence claim "${lease.key}" ended before its run finished. Another process can run it too. Make the claim TTL longer than a pause of this process.`))
    })
  }, Math.max(1, Math.floor(ttlMs / 3)))
  timer.unref?.()
  return () => clearInterval(timer)
}

export function createOccurrenceClaims(options: OccurrenceClaimsOptions): OccurrenceClaims {
  const ttl = options.ttlMs / 1000
  const doneTtl = options.doneTtlMs / 1000
  const owner = options.owner === undefined ? {} : { owner: options.owner }
  return {
    async run(runId, run) {
      const [acquireError, lease] = await options.leases.acquire(occurrenceLeaseKey(runId), { ttl, ...owner })
      if (acquireError) throw acquireError
      if (!lease) return "held"
      try {
        const [doneError, done] = await options.leases.get(occurrenceDoneKey(runId))
        if (doneError) throw doneError
        if (done) return "done"
        const stop = keepAlive(lease, options.ttlMs, options.reportError)
        try {
          await run()
        }
        finally {
          stop()
          const [markError, marked] = await options.leases.acquire(occurrenceDoneKey(runId), { ttl: doneTtl, ...owner })
          if (markError) options.reportError(markError)
          else if (!marked) options.reportError(new Error(`[vitehub] Schedule occurrence "${runId}" already had a done marker. Two processes ran it.`))
        }
        return "ran"
      }
      finally {
        // A failed release leaves the claim until its TTL ends. The done marker already stops a second run.
        const [releaseError] = await lease.release()
        if (releaseError) options.reportError(releaseError)
      }
    },
  }
}
