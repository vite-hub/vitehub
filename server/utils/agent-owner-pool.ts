type PullRequestJob = {
  number: number
}

type AgentOwnerPoolOptions<TJob extends PullRequestJob> = {
  onError: (job: TJob, error: unknown) => void
  run: (job: TJob) => Promise<void>
}

export function createAgentOwnerPool<TJob extends PullRequestJob>({ onError, run }: AgentOwnerPoolOptions<TJob>) {
  const active = new Map<number, Promise<void>>()
  let tail = Promise.resolve()

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

        let owner: Promise<void>
        owner = tail
          .then(() => run(job))
          .catch(error => onError(job, error))
          .finally(() => {
            if (active.get(job.number) === owner) active.delete(job.number)
          })
        active.set(job.number, owner)
        tail = owner
        started.push(job.number)
      }

      return started
    },
  }
}
