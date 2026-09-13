import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { ProcessReconcilerRunContext } from "@vite-hub/runtime/node"
import { createMessage, defineAgent, runScheduledAgent } from "../../index.ts"
import type { CodexDriverOptions } from "../../index.ts"
import { createGitHubPullRequestRun, createGitHubPullRequestOperations } from "../../server/github.ts"
import type { GitHubHost } from "../../server/github.ts"
import {
  PullRequestInbox, normalizePullRequest, snapshotPrompt, assertPromptFits,
  snapshotPullRequest, createClaimStopCheck, hydrateSnapshot, reconcileOneSnapshot, readPullRequestThreads,
} from "../../server/github-inbox.ts"
import type { Claim } from "../../server/github-inbox.ts"
import { babysitter, babysitterPassResultSchema } from "../babysitter.ts"
import type { BabysitterPassResult } from "../babysitter.ts"
import { repairCapability, repairEnvironment } from "./repair.ts"

export interface BabysitterRuntimeOptions {
  agent: typeof babysitter
  github: GitHubHost
  inboxPath: string
  repositories: string[]
  concurrency: number
  publicUrl?: string
  sessionUrl?: (runId: string) => string
  event?: (name: string, properties: Record<string, unknown>) => void
  error?: (name: string, error: unknown, properties: Record<string, unknown>) => void
  wake?: () => void
}

/** Own one durable PR inbox and its repair passes inside a process host. */
export function createBabysitterRuntime(options: BabysitterRuntimeOptions) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Babysitter concurrency must be a positive integer.")
  }
  const github = options.github
  const pullRequestInbox = new PullRequestInbox({ path: options.inboxPath, repositories: options.repositories, filter: options.agent.options.filter })
  pullRequestInbox.recoverLeases()
  const schedulerEvent = (name: string, properties: Record<string, unknown> = {}) => options.event?.(name, properties)
  const schedulerError = (name: string, error: unknown, properties: Record<string, unknown> = {}) => options.error?.(name, error, properties)
const active = new Set<string>()
const execFileAsync = promisify(execFile)
async function readRest(path: string, projection = '.[]') {
  const repository = path.split('/').slice(1, 3).join('/')
  const result = await github.command(['api', '--paginate', path, '--jq', `${projection} | @json`], { repository })
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function readThreads(repository: string, number: number) {
  return readPullRequestThreads(async (query, variables) => {
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
    }
    const result = await github.command(args, { repository })
    return JSON.parse(result.stdout)
  }, repository, number)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

function cancelWhenPullRequestStops(claim: Claim, controller: AbortController, providerDirectory: () => string | undefined): () => void {
  let stopped = false, polling = false
  const check = createClaimStopCheck(claim,
    () => pullRequestInbox.get(claim.snapshot.repository, claim.snapshot.number),
    async () => {
      const cwd = providerDirectory()
      if (!cwd) return undefined
      const result = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 })
      return result.stdout.trim()
    })
  const poll = async () => {
    if (stopped || polling || controller.signal.aborted) return
    polling = true
    try {
      const reason = await check()
      if (reason && !stopped) controller.abort(new DOMException(reason, 'AbortError'))
    } catch {
      if (!stopped) controller.abort(new DOMException('Unable to verify active pull request state.', 'AbortError'))
    } finally { polling = false }
  }
  // Local snapshots handle cancellation. Git is consulted only after a head
  // change, to distinguish the provider's repair push from an external push.
  const interval = setInterval(() => { void poll() }, 2000)
  void poll()
  return () => { stopped = true; clearInterval(interval) }
}

function workload() { return { running: active.size } }

async function reconcile(
  reason: string,
  { track }: ProcessReconcilerRunContext,
  isAccepting: () => boolean = () => true,
) {
  const startedAt = new Date()
  const schedule = {
    id: 'babysitter-demand',
    runId: `demand:${startedAt.toISOString()}`,
    scheduledAt: startedAt,
  }
  const { publicUrl, repositories } = options
  if (!isAccepting()) return
  const ownerLimit = options.concurrency
  // Bootstrap once per repository and persist even an empty successful list.
  // Failed reads stay retryable; they must never masquerade as empty success.
  for (const repository of repositories) {
    const key = `bootstrap-rest-v1:${repository}`
    const previous = pullRequestInbox.meta<{ at: string }>(key)
    if (previous && Date.now() - Date.parse(previous.at) < 30 * 60_000) continue
    // Failed bootstraps retry on the repair timer, not on every owner wake.
    const nextKey = `${key}:next`
    if ((pullRequestInbox.meta<number>(nextKey) ?? 0) > Date.now()) continue
    pullRequestInbox.setMeta(nextKey, Date.now() + 2 * 60_000)
    try {
      const result = await github.command(['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`, '--jq', '.[] | @json'], { repository })
      const prs = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      for (const pr of prs) pullRequestInbox.seed(repository, normalizePullRequest(pr))
      pullRequestInbox.setMeta(key, { at: new Date().toISOString() })
    } catch (error) { schedulerError('babysitter.bootstrap.failed', error, { repository }) }
  }
  try { await reconcileOneSnapshot(pullRequestInbox, readRest, Date.now(), readThreads) }
  catch (error) { schedulerError('babysitter.snapshot.reconcile.failed', error) }
  if (!isAccepting()) return
  // The durable inbox is the sole eligibility checkpoint. A second work
  // tracker checkpoint used to swallow new webhook generations and leak
  // their leases for two hours.
  const jobs = pullRequestInbox.claim(Math.max(0, ownerLimit - active.size))
  if (!jobs.length) return // tracking an already-resolved batch creates wake loops
  for (const claim of jobs) active.add(`${claim.snapshot.repository}#${claim.snapshot.number}`)
  schedulerEvent('babysitter.queue.selected', { reason, selected: jobs.length, owner_limit: ownerLimit, active_owners: active.size })
  const batchStartedAt = Date.now()

  schedulerEvent('babysitter.batch.started', {
    jobs: jobs.length,
    maxOwners: ownerLimit,
    reason,
    repositories,
    scheduleId: schedule.runId || schedule.id,
  })
  const batch = Promise.allSettled(jobs.map(async inboxClaim => {
    const repository = inboxClaim.snapshot.repository
    const number = inboxClaim.snapshot.number
    const runId = `${schedule.runId}:${repository}:pr-${number}:generation-${inboxClaim.generation}`
    const owner = { pullRequest: number, repository, runId }
    const startedAt = Date.now()
    let outcome = 'completed'
    let disposition: BabysitterPassResult['disposition'] | undefined
    let resultText = ''
    schedulerEvent('babysitter.owner.started', { maxOwners: ownerLimit, ...owner })
    try {
        // Unknown PRs (a comment arriving before opened) need exactly one
        // targeted REST hydration. Normal webhook claims use the local head.
        if (!await hydrateSnapshot(pullRequestInbox, inboxClaim, readRest, readThreads)) {
          pullRequestInbox.release(inboxClaim)
          return
        }
        if (!pullRequestInbox.eligible(repository, inboxClaim.snapshot.pr)) {
          pullRequestInbox.finish(inboxClaim, { text: 'PR closed or outside the configured filter.', terminal: true })
          return
        }
        const pullRequest = snapshotPullRequest(inboxClaim.snapshot)
        const webhookSnapshot = inboxClaim.snapshot
        await github.withPullRequestCheckout({
          headRef: pullRequest.headRefName,
          headRepository: pullRequest.headRepository?.nameWithOwner,
          headSha: pullRequest.headRefOid,
          number: pullRequest.number,
          repository,
        }, async (prepared) => {
          const checkout = prepared.path
          schedulerEvent('babysitter.checkout.ready', {
            repository,
            pull_request: pullRequest.number,
            head_sha: pullRequest.headRefOid,
          })
          const context = {
            preparedCheckout: checkout,
            pullRequestHead: pullRequest.headRefOid,
            pullRequestNumber: pullRequest.number,
            pullRequestRepository: repository,
            pullRequestSourceBranch: pullRequest.headRefName,
            pullRequestSourceRepository: pullRequest.headRepository?.nameWithOwner || '(unavailable)',
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.url,
          }
          let providerDirectory: string | undefined
          const operations = createGitHubPullRequestOperations(github, {
            repository, number, expectedHeadOid: pullRequest.headRefOid,
            autoMerge: options.agent.options.autoMerge,
            eligible: current => pullRequestInbox.eligible(repository, normalizePullRequest(current)),
            push: async () => {
              if (!providerDirectory) throw new Error("The repair workspace is not prepared.")
              return await prepared.push(providerDirectory)
            },
          })
          const settings = options.agent.__vitehubWorkspaceAgentOptions
          const driver = settings.driver
          if (!driver || typeof driver !== "object" || !("kind" in driver) || driver.kind !== "codex") {
            throw new Error("Babysitter requires a Codex driver for its isolated Git checkout.")
          }
          const workerDriver = driver as CodexDriverOptions<BabysitterPassResult> & { kind: "codex" }
          const agent = defineAgent({
            extends: options.agent,
            name: "babysitter-worker",
            channels: { github: github.channel({ activity: true, pullRequest: { filter: options.agent.options.filter } }) },
            capabilities: [repairCapability(operations, options.agent.options.autoMerge)],
            driver: {
              ...workerDriver,
              permissions: "allow-edits",
              env: async context => {
                const environment = typeof workerDriver.env === "function" ? await workerDriver.env(context) : workerDriver.env
                return repairEnvironment(environment)
              },
              launch: async context => {
                await prepared.prepareWorkspace(context.cwd)
                providerDirectory = context.cwd
                return workerDriver.launch ? await workerDriver.launch(context) : { command: context.command }
              },
            },
            workspace: { commit: false, mode: "write", store: { provider: "local", root: checkout } },
          })
          const prompt = `Repair PR #${number} in ${repository}. Expected HEAD ${pullRequest.headRefOid}, source branch ${pullRequest.headRefName}, source repository ${pullRequest.headRepository?.nameWithOwner ?? "unavailable"}. ${pullRequest.url}`
          const snapshotContext = snapshotPrompt(webhookSnapshot)
          const userMessage = `${prompt}\n\n${snapshotContext}`
          assertPromptFits(userMessage)
          schedulerEvent('babysitter.context.prepared', { repository, pull_request: number, characters: snapshotContext.length, format: 'xml' })
          const passController = new AbortController()
          const githubRun = await createGitHubPullRequestRun(repository, pullRequest, {
            agentName: 'babysitter', runId, publicUrl,
            sessionUrl: options.sessionUrl?.(runId),
          })
          // The GitHub run helper uses a stable PR thread id. Scope the
          // provider session to this exact head so a new checkout never
          // resumes a Codex process whose temporary cwd was deleted.
          githubRun.threadId = `${githubRun.threadId}:${pullRequest.headRefOid}`
          const stopPullRequestWatch = cancelWhenPullRequestStops(inboxClaim, passController, () => providerDirectory)
          const result = await runScheduledAgent(agent, {
            ...schedule,
            runId,
          }, {
            runtime: 'vite',
            run: githubRun,
          }, {
            abortSignal: AbortSignal.any([AbortSignal.timeout(60 * 60 * 1000), passController.signal]),
            context,
            messages: [createMessage({ role: 'user', text: userMessage })],
          }).finally(stopPullRequestWatch)
          const validated = babysitterPassResultSchema["~standard"].validate(result)
          if ("issues" in validated) throw new Error("Babysitter returned an invalid pass result.")
          disposition = validated.value.disposition
          resultText = validated.value.text

        })

        const current = pullRequestInbox.get(repository, number)
        const terminal = current?.status === 'terminal'
        const parked = terminal || disposition === 'park'
        outcome = parked ? 'completed' : 'retry'
        pullRequestInbox.finish(inboxClaim, { text: resultText, retry: !parked, terminal })
    }
    catch (error) {
      if (isAbortError(error)) {
        outcome = 'completed'
        pullRequestInbox.finish(inboxClaim, { text: 'Pass interrupted; current webhook state retained.', retry: true, terminal: pullRequestInbox.get(repository, number)?.status === 'terminal' })
        schedulerEvent('babysitter.owner.cancelled', { reason: 'pull-request-state-changed-or-aborted', ...owner })
      }
      else if (github.isRateLimitError(error)) {
        outcome = 'deferred'
        pullRequestInbox.finish(inboxClaim, { text: 'GitHub rate limit; retrying after budget reset.', retry: true })
        schedulerEvent('babysitter.owner.deferred', { reason: 'github-rate-limit', ...owner })
      }
      else {
        outcome = 'failed'
        if (/AGENT_R0767|head.*(?:mismatch|changed)|expected.*head/i.test(String(error))) {
          pullRequestInbox.hydrate(inboxClaim, { refresh: true })
        }
        pullRequestInbox.finish(inboxClaim, {
          text: error instanceof Error ? error.message : String(error),
          retry: true,
        })
        schedulerError('babysitter.owner.failed', error, owner)
      }
    }
    finally {
      schedulerEvent('babysitter.owner.finished', {
        durationMs: Date.now() - startedAt,
        outcome,
        ...owner,
      })
      active.delete(`${repository}#${number}`)
      options.wake?.()
    }
  })).then(() => {}).finally(() => {
    schedulerEvent('babysitter.batch.finished', {
      durationMs: Date.now() - batchStartedAt,
      jobs: jobs.length,
      maxOwners: ownerLimit,
      repositories,
      scheduleId: schedule.runId || schedule.id,
    })
  }).catch(error => schedulerError('babysitter.batch.failed', error, { scheduleId: schedule.runId }))
  track(batch)
}

  return { inbox: pullRequestInbox, reconcile, workload }
}
