import { forgeEnv, readForgeEnv } from "@vite-hub/forge"
import { githubHmacSignatureFormat, verifyViteHubHmacSignature } from "@vite-hub/internal/secret"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { warnDiagnostic } from "./diagnostic-log.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentSourceHeadsRuntime } from "./source-heads.ts"

import type { ContentPrewarmJob, ContentPushedChanges, ContentSourceHeads } from "./source-heads.ts"

/** The route of the GitHub push webhook that ViteHub generates when `server/content.ts` uses a `github()` Source. */
export const contentGitHubWebhookRoute = "/_vitehub/content/github"

/** The name of the Queue that prewarms the pages of a push, when the app has ViteHub Queue. */
export const contentPrewarmQueueName = "vitehub-content-prewarm"

/** GitHub puts at most this many commits in a push payload. A push with more lists only some of its files. */
const pushCommitLimit = 2048

/** The fields of a GitHub `push` payload that Content reads. */
interface PushPayload {
  ref: string
  before: string | null
  after: string | null
  deleted: boolean
  /** The repository paths that the commits changed, or undefined when the payload cannot list them all. */
  paths: string[] | undefined
  repository: { full_name: string, default_branch?: string }
}

/** The added, modified, and removed paths of every commit, or undefined for a forced or cut push. */
function pushedPaths(value: object): string[] | undefined {
  const commits: unknown = Reflect.get(value, "commits")
  if (Reflect.get(value, "forced") === true || !Array.isArray(commits) || commits.length >= pushCommitLimit) return
  const paths: string[] = []
  for (const commit of commits as unknown[]) {
    if (typeof commit !== "object" || commit === null) return
    for (const field of ["added", "modified", "removed"]) {
      const list: unknown = Reflect.get(commit, field)
      if (!Array.isArray(list) || !list.every(path => typeof path === "string")) return
      paths.push(...list as string[])
    }
  }
  return paths
}

function readPush(text: string, contentType: string | null): PushPayload | undefined {
  let value: unknown
  try {
    // A webhook with the content type `application/x-www-form-urlencoded` sends the JSON in the `payload` field.
    value = JSON.parse(contentType?.includes("x-www-form-urlencoded") ? new URLSearchParams(text).get("payload") ?? "" : text)
  }
  catch {
    return
  }
  if (typeof value !== "object" || value === null) return
  const ref: unknown = Reflect.get(value, "ref")
  const after: unknown = Reflect.get(value, "after")
  const before: unknown = Reflect.get(value, "before")
  const repository: unknown = Reflect.get(value, "repository")
  if (typeof ref !== "string" || typeof repository !== "object" || repository === null) return
  const fullName: unknown = Reflect.get(repository, "full_name")
  const defaultBranch: unknown = Reflect.get(repository, "default_branch")
  if (typeof fullName !== "string") return
  return {
    ref,
    before: typeof before === "string" ? before : null,
    after: typeof after === "string" ? after : null,
    paths: pushedPaths(value),
    deleted: Reflect.get(value, "deleted") === true,
    repository: { full_name: fullName, ...(typeof defaultBranch === "string" ? { default_branch: defaultBranch } : {}) },
  }
}

export interface ContentGitHubWebhookOptions {
  /**
   * Send one prewarm job to a Queue, such as `job => dynamicQueue.send(contentPrewarmQueueName, job)`. The Queue handler
   * calls `prewarmContentPage(content, job)`. Without it, the webhook loads the changed pages itself, after the
   * response when the host has `waitUntil`. ViteHub passes it when the app has ViteHub Queue.
   */
  prewarm?: (job: ContentPrewarmJob) => Promise<unknown>
}

/**
 * Serve the GitHub push webhook of Content as a Fetchable route. A signed `push` to the branch of a `github()` Source
 * calls `content.sources.advance()` for that Source, after the response when the host has `waitUntil`. It checks
 * `X-Hub-Signature-256` with the Server Env `VITEHUB_GITHUB_WEBHOOK_SECRET`, and answers 404 without that secret.
 * ViteHub generates it at `/_vitehub/content/github`; mount it yourself in another server.
 *
 * When the head moves, each changed page loads at the new commit, so its first read is warm: one prewarm job per page,
 * through `options.prewarm` or in this request. The changed pages come from the `commits` of the push, or from a
 * compare of the files of both commits when the push was forced, cut, or did not start at the old head.
 */
export function defineContentGitHubWebhookHandler(content: { sources: ContentSourceHeads }, options: ContentGitHubWebhookOptions = {}): { fetch(request: Request): Promise<Response> } {
  let reportedMissingSecret = false
  return {
    async fetch(request) {
      const secret = readForgeEnv(forgeEnv.github.webhookSecret)
      if (!secret) {
        if (!reportedMissingSecret) warnDiagnostic(contentErrorDiagnostics.CONTENT_R0026())
        reportedMissingSecret = true
        return new Response("Not Found", { status: 404 })
      }
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } })
      const delivery = request.headers.get("x-github-delivery")
      const body = new Uint8Array(await request.arrayBuffer())
      if (!await verifyViteHubHmacSignature(secret, request.headers.get("x-hub-signature-256"), body, githubHmacSignatureFormat)) {
        const diagnostic = contentErrorDiagnostics.CONTENT_R0024({ delivery })
        warnDiagnostic(diagnostic)
        return Response.json({ code: diagnostic.code, error: diagnostic.message }, { status: 401 })
      }
      const event = request.headers.get("x-github-event")
      if (event === "ping") return Response.json({ ok: true })
      if (event !== "push") return Response.json({ ignored: `GitHub event ${JSON.stringify(event)} is not a push.` })
      const push = readPush(new TextDecoder().decode(body), request.headers.get("content-type"))
      if (!push) return Response.json({ error: "The push payload has no ref or repository." }, { status: 400 })
      if (push.deleted) return Response.json({ ignored: `The push deleted ${push.ref}.` })
      const runtime = contentSourceHeadsRuntime(content.sources)
      const match = runtime?.match(push.repository.full_name, push.ref, push.repository.default_branch) ?? { repository: false, sources: [] }
      if (!match.repository) {
        const diagnostic = contentErrorDiagnostics.CONTENT_R0025({ repo: push.repository.full_name, heads: runtime?.names().join(", ") || "none" })
        warnDiagnostic(diagnostic)
        return Response.json({ code: diagnostic.code, ignored: diagnostic.message })
      }
      if (!runtime || !match.sources.length) return Response.json({ ignored: `No github() Source follows ${push.ref}.` })
      const work = Promise.all(match.sources.map(name => runtime.deliver(name, { id: delivery, sha: push.after })))
      const pushed: ContentPushedChanges | undefined = push.paths ? { before: push.before, paths: push.paths } : undefined
      // A moved head prewarms its changed pages, so their first reads are warm.
      const prewarm = async (name: string, before: string | null | undefined) => {
        const { sha } = await runtime.api.head(name)
        if (!sha) return
        const jobs = (await runtime.changed(name, before ?? null, sha, pushed)).map(key => ({ source: name, sha, key }))
        const send = options.prewarm
        if (send) await Promise.all(jobs.map(job => send(job)))
        else for (const job of jobs) await runtime.prewarm(job)
      }
      const waitUntil = getStandardContext(request).waitUntil
      if (waitUntil) {
        // After the response, a moved head also computes its page dates, so no feed or sitemap request waits for them.
        const after = work.then(deliveries => Promise.all(deliveries.map((result, index) => result.result === "moved"
          ? Promise.all([runtime.moved(match.sources[index]!), prewarm(match.sources[index]!, result.before)])
          : undefined)))
        waitUntil(after.catch((error: unknown) => console.error(error)))
        return Response.json({ sources: match.sources }, { status: 202 })
      }
      const deliveries = await work
      // A failed prewarm leaves the pages cold. The head has moved, so the delivery still succeeded.
      await Promise.all(deliveries.map((result, index) => result.result === "moved" ? prewarm(match.sources[index]!, result.before) : undefined))
        .catch((error: unknown) => console.error(error))
      return Response.json({ sources: match.sources, deliveries })
    },
  }
}

/**
 * Load one changed page of a push at the head commit in this server instance, for the Queue handler of
 * `contentPrewarmQueueName`. A job for a head that has moved on does nothing.
 */
export async function prewarmContentPage(content: { sources: ContentSourceHeads }, job: ContentPrewarmJob): Promise<void> {
  const runtime = contentSourceHeadsRuntime(content.sources)
  if (!runtime || !job || typeof job.source !== "string" || typeof job.sha !== "string" || typeof job.key !== "string") {
    console.error("[vitehub] The Content prewarm Queue got a job that is not a page of a push. It skips the job.")
    return
  }
  await runtime.prewarm(job)
}
