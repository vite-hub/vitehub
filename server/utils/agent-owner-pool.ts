type PullRequestJob = {
  number: number
}

type AgentOwnerPoolOptions<TJob extends PullRequestJob> = {
  concurrency: number
  onError: (job: TJob, error: unknown) => void
  run: (job: TJob) => Promise<void>
}

export function createAgentOwnerPool<TJob extends PullRequestJob>({ concurrency, onError, run }: AgentOwnerPoolOptions<TJob>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Agent owner concurrency must be a positive integer.')

  const active = new Map<number, Promise<void>>()
  const lanes = Array.from({ length: concurrency }, () => Promise.resolve())
  let nextLane = 0

  return {
    activePullRequests() {
      return new Set(active.keys())
    },
    async settle() {
      await Promise.all(active.values())
    },
    summon(jobs: TJob[]) {
      const started: number[] = []

      for (const job of jobs) {
        if (active.has(job.number)) continue

        const lane = nextLane
        nextLane = (nextLane + 1) % lanes.length
        let owner: Promise<void>
        owner = lanes[lane]!
          .then(() => run(job))
          .catch(error => onError(job, error))
          .finally(() => {
            if (active.get(job.number) === owner) active.delete(job.number)
          })
        active.set(job.number, owner)
        lanes[lane] = owner
        started.push(job.number)
      }

      return started
    },
  }
}
