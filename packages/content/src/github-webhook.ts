import { forgeEnv, readForgeEnv } from "@vite-hub/forge"
import { githubHmacSignatureFormat, verifyViteHubHmacSignature } from "@vite-hub/internal/secret"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { formatDiagnostic } from "nostics"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { contentSourceHeadsRuntime } from "./source-heads.ts"

import type { ContentSourceHeads } from "./source-heads.ts"

/** The route of the GitHub push webhook that ViteHub generates when `server/content.ts` uses a `github()` Source. */
export const contentGitHubWebhookRoute = "/_vitehub/content/github"

/** The fields of a GitHub `push` payload that Content reads. */
interface PushPayload {
  ref: string
  after: string | null
  deleted: boolean
  repository: { full_name: string, default_branch?: string }
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
  const repository: unknown = Reflect.get(value, "repository")
  if (typeof ref !== "string" || typeof repository !== "object" || repository === null) return
  const fullName: unknown = Reflect.get(repository, "full_name")
  const defaultBranch: unknown = Reflect.get(repository, "default_branch")
  if (typeof fullName !== "string") return
  return {
    ref,
    after: typeof after === "string" ? after : null,
    deleted: Reflect.get(value, "deleted") === true,
    repository: { full_name: fullName, ...(typeof defaultBranch === "string" ? { default_branch: defaultBranch } : {}) },
  }
}

/**
 * Serve the GitHub push webhook of Content as a Fetchable route. A signed `push` to the branch of a `github()` Source
 * calls `content.sources.advance()` for that Source, after the response when the host has `waitUntil`. It checks
 * `X-Hub-Signature-256` with the Server Env `VITEHUB_GITHUB_WEBHOOK_SECRET`, and answers 404 without that secret.
 * ViteHub generates it at `/_vitehub/content/github`; mount it yourself in another server.
 */
export function defineContentGitHubWebhookHandler(content: { sources: ContentSourceHeads }): { fetch(request: Request): Promise<Response> } {
  let reportedMissingSecret = false
  return {
    async fetch(request) {
      const secret = readForgeEnv(forgeEnv.github.webhookSecret)
      if (!secret) {
        if (!reportedMissingSecret) console.warn(formatDiagnostic(contentErrorDiagnostics.CONTENT_R0026()))
        reportedMissingSecret = true
        return new Response("Not Found", { status: 404 })
      }
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } })
      const delivery = request.headers.get("x-github-delivery")
      const body = new Uint8Array(await request.arrayBuffer())
      if (!await verifyViteHubHmacSignature(secret, request.headers.get("x-hub-signature-256"), body, githubHmacSignatureFormat)) {
        const diagnostic = contentErrorDiagnostics.CONTENT_R0024({ delivery })
        console.warn(formatDiagnostic(diagnostic))
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
        console.warn(formatDiagnostic(diagnostic))
        return Response.json({ code: diagnostic.code, ignored: diagnostic.message })
      }
      if (!runtime || !match.sources.length) return Response.json({ ignored: `No github() Source follows ${push.ref}.` })
      const work = Promise.all(match.sources.map(name => runtime.deliver(name, { id: delivery, sha: push.after })))
      const waitUntil = getStandardContext(request).waitUntil
      if (waitUntil) {
        // After the response, a moved head also computes its page dates, so no feed or sitemap request waits for them.
        const after = work.then(deliveries => Promise.all(deliveries.map((result, index) => result.result === "moved" ? runtime.moved(match.sources[index]!) : undefined)))
        waitUntil(after.catch((error: unknown) => console.error(error)))
        return Response.json({ sources: match.sources }, { status: 202 })
      }
      return Response.json({ sources: match.sources, deliveries: await work })
    },
  }
}
