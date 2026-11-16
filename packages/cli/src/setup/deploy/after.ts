import type { DeploymentDeployManifest } from "@vite-hub/internal/build/deployment-plan-output"
import type { DeployHost, HostDeployment } from "./host.ts"

/** One path of `deploy.check`, as the deployed app answered it. */
export interface DeployCheckResult {
  path: string
  url: string
  ok: boolean
  /** The last HTTP status. Missing when no request got an answer. */
  status?: number
  /** Why the last request got no answer, such as a timeout. */
  error?: string
}

/** How to put the previous production deployment back, when a check fails. */
export interface DeployRollback {
  /** The deployment that received production traffic before this deploy. Missing on a first deploy or when it is not known. */
  previous?: { deploymentId: string, version?: string }
  /** The command that rolls production back to `previous`. Missing when the host has no rollback command. */
  command?: string
  /** What to do when there is no command, or why `previous` is not known. */
  note?: string
}

/** What `vitehub deploy --json` prints for the IndexNow submission. */
export type DeployIndexNowOutput =
  | { submitted: number, status: number }
  | { error: string, status?: number }

/** Waits between the attempts of one path: a new version can take a few seconds to reach every edge location. */
export const checkRetryDelaysMs: readonly number[] = [1_000, 2_000, 4_000]
const checkTimeoutMs = 10_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function reason(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `no answer within ${checkTimeoutMs / 1000} seconds`
  return error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
}

/**
 * Requests each path on the deployed URL until it answers with a 2xx status, with a few retries. Redirects are
 * followed, so the final answer counts. The request asks the cache to skip, so a cached answer of the previous version
 * does not pass the check.
 */
export async function runDeployChecks(baseUrl: string, paths: readonly string[], fetchImpl: typeof fetch, delays: readonly number[] = checkRetryDelaysMs): Promise<DeployCheckResult[]> {
  const origin = new URL(baseUrl)
  return await Promise.all(paths.map(async (path) => {
    const url = new URL(path, origin).href
    let last: DeployCheckResult = { ok: false, path, url }
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt) await sleep(delays[attempt - 1]!)
      try {
        const response = await fetchImpl(url, { cache: "no-store", headers: { "cache-control": "no-cache", "user-agent": "vitehub-deploy-check" }, redirect: "follow", signal: AbortSignal.timeout(checkTimeoutMs) })
        await response.body?.cancel()
        last = { ok: response.ok, path, status: response.status, url }
      }
      catch (error: unknown) {
        last = { error: reason(error), ok: false, path, url }
      }
      if (last.ok) break
    }
    return last
  }))
}

/** One line per failed check, such as `/api/health: 503` or `/: fetch failed`. */
export function formatFailedChecks(checks: readonly DeployCheckResult[]): string {
  return checks.filter(check => !check.ok).map(check => `${check.path}: ${check.status ?? check.error ?? "no answer"}`).join(", ")
}

function quote(value: string): string {
  return /^[\w./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The rollback of each host, from its CLI help in test/fixtures/host-cli-help/:
 * - Wrangler 4.158 `wrangler rollback <version-id> --name <worker> --yes`.
 * - Vercel CLI 65.16 `vercel rollback <deployment> --yes`.
 * - Netlify CLI 27.11 `netlify api restoreSiteDeploy`, the `POST /sites/{site_id}/deploys/{deploy_id}/restore` API.
 * - Deno Deploy CLI 0.0.9909 has no rollback command.
 */
export function rollbackFor(host: DeployHost, input: { previous: HostDeployment | undefined, projectName: string, siteId?: string, lookupFailed?: string }): DeployRollback {
  const { previous } = input
  if (!previous) {
    return { note: input.lookupFailed ? `The previous production deployment is not known: ${input.lookupFailed} Run \`vitehub deployments\` to find it.` : "This was the first production deploy, so there is no earlier deployment to roll back to." }
  }
  const described = { deploymentId: previous.id, ...(previous.version ? { version: previous.version } : {}) }
  switch (host) {
    case "cloudflare": return { command: `npx wrangler rollback ${quote(previous.version ?? previous.id)} --name ${quote(input.projectName)} --yes`, previous: described }
    case "vercel": return { command: `npx vercel rollback ${quote(previous.id)} --yes`, previous: described }
    case "netlify": return input.siteId
      ? { command: `npx netlify api restoreSiteDeploy --data ${quote(JSON.stringify({ deploy_id: previous.id, site_id: input.siteId }))}`, previous: described }
      : { note: `Publish deploy ${previous.id} again in the Netlify dashboard, under Deploys.`, previous: described }
    case "deno": return { note: `The Deno Deploy CLI has no rollback command. Promote revision ${previous.id} to production in the Deno Deploy dashboard.`, previous: described }
  }
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/gu, (_, name: string) => ({ amp: "&", apos: "'", gt: ">", lt: "<", quot: "\"" })[name]!)
}

function locations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gu)].map(match => decodeXml(match[1]!))
}

/** IndexNow takes at most 10,000 URLs in one request. */
const indexNowBatch = 10_000
/** A sitemap index may list sitemaps on other paths. Read at most this many. */
const nestedSitemapLimit = 50

/**
 * Reads `<url>/sitemap.xml`, one level of a sitemap index included, and sends every URL of the site to IndexNow.
 * https://www.indexnow.org/documentation: 200 and 202 accept the URLs, 403 means the key file was not found.
 */
export async function submitIndexNow(indexNow: NonNullable<DeploymentDeployManifest["indexNow"]>, fetchImpl: typeof fetch): Promise<DeployIndexNowOutput> {
  const origin = new URL(indexNow.url)
  const read = async (url: string) => {
    const response = await fetchImpl(url, { headers: { "user-agent": "vitehub-deploy" }, signal: AbortSignal.timeout(checkTimeoutMs) })
    if (!response.ok) throw Object.assign(new Error(`${url} answered ${response.status}.`), { status: response.status })
    return await response.text()
  }
  const sameSite = (url: string) => URL.canParse(url) && new URL(url).origin === origin.origin
  let urls: string[]
  try {
    const sitemap = await read(new URL("/sitemap.xml", origin).href)
    urls = /<sitemapindex[\s>]/u.test(sitemap)
      ? (await Promise.all(locations(sitemap).filter(sameSite).slice(0, nestedSitemapLimit).map(read))).flatMap(locations)
      : locations(sitemap)
  }
  catch (error: unknown) {
    const status: unknown = error instanceof Error ? Reflect.get(error, "status") : undefined
    return { error: `The sitemap could not be read: ${reason(error)}`, ...(typeof status === "number" ? { status } : {}) }
  }
  const urlList = [...new Set(urls.filter(sameSite))]
  if (!urlList.length) return { error: `${origin.origin}/sitemap.xml lists no URL of ${origin.host}.` }
  let status = 0
  for (let start = 0; start < urlList.length; start += indexNowBatch) {
    const response = await fetchImpl("https://api.indexnow.org/indexnow", {
      body: JSON.stringify({ host: origin.host, key: indexNow.key, keyLocation: `${origin.origin}/${indexNow.key}.txt`, urlList: urlList.slice(start, start + indexNowBatch) }),
      headers: { "content-type": "application/json; charset=utf-8" },
      method: "POST",
      signal: AbortSignal.timeout(checkTimeoutMs),
    }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
    if (response instanceof Error) return { error: `IndexNow did not answer: ${reason(response)}` }
    await response.body?.cancel()
    status = response.status
    if (status === 403) return { error: `IndexNow did not find the key file at ${origin.origin}/${indexNow.key}.txt.`, status }
    if (!response.ok) return { error: `IndexNow answered ${status}.`, status }
  }
  return { status, submitted: urlList.length }
}
