import { existsSync } from "node:fs"

import { resolveHostCredentials } from "@vite-hub/internal/host-credentials"
import { createNetlifyApiClient, isProvisionRequestError } from "@vite-hub/internal/provision"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { setupFailure, setupExitCodes } from "../envelope.ts"
import { commitMessage, hostCli, hostCliFailed, hostListFailed, isoTime, isRecord, lastJsonObject, optionalString, parseCommitMessage } from "./host.ts"

import type { DeployAdapter, DeployContext, HostDeployment, HostEnv, HostEnvContext, ListDeployments } from "./host.ts"

interface NetlifySite {
  id: string
  accountId?: string
}

/** Nitro's Netlify preset writes static files to `dist` (`output.publicDir`). */
const publishDir = "dist"

// Netlify CLI 27.11: `netlify deploy --help`, recorded in test/fixtures/host-cli-help/. The CLI reads NETLIFY_AUTH_TOKEN
// from the environment.
export function netlifyAdapter(context: DeployContext): DeployAdapter {
  const netlify = hostCli("netlify", "netlify-cli", context.root, context.env)
  const linked = context.link?.host === "netlify" && context.link.project.id ? context.link : undefined
  let site: NetlifySite | undefined = linked?.project.id ? { id: linked.project.id, ...(linked.account ? { accountId: linked.account.id } : {}) } : undefined

  return {
    async deploy() {
      const args = ["deploy", "--no-build", "--dir", publishDir, "--json", ...(context.preview ? ["--context", "deploy-preview"] : ["--prod"])]
      // ViteHub writes this wrapper for the older Nitro layout. Netlify finds `.netlify/v1/functions` by itself.
      if (existsSync(join(context.outputDir, "functions", "server.mjs"))) args.push("--functions", join(context.outputDir, "functions"))
      args.push(...(site ? ["--site", site.id] : ["--site-name", context.projectName]))
      if (context.commit) args.push("--message", commitMessage(context.commit))
      const result = await context.run(netlify[0], [...netlify.slice(1), ...args], { cwd: context.root, env: context.env, show: true })
      if (result.exitCode !== 0) throw hostCliFailed("netlify deploy", result, context.secrets)
      const json = lastJsonObject(result.stdout)
      const url = optionalString(json?.url) ?? optionalString(json?.deploy_url)
      if (!url) throw hostCliFailed("netlify deploy printed no URL", result, context.secrets)
      const siteId = optionalString(json?.site_id)
      if (siteId && siteId !== site?.id) site = { id: siteId }
      const deploymentId = optionalString(json?.deploy_id)
      const name = optionalString(json?.site_name) ?? context.projectName
      return { url, ...(deploymentId ? { deploymentId } : {}), project: { ...(site ? { id: site.id } : {}), name, ...(site?.accountId ? { accountId: site.accountId } : {}) } }
    },
  }
}

/** The Netlify deploy context of a host env target. */
const netlifyContexts = { preview: "deploy-preview", production: "production" } as const

/**
 * The environment variables of the linked site for one deploy context. Netlify CLI 27.11 (`netlify env:list --help`,
 * `netlify env:import --help`, in test/fixtures/host-cli-help/). `env:list --json` prints the names with values, so
 * its stdout never goes into an error. `env:set` takes the value as an argument, and `env:import` replaces a variable
 * in every context, so a value goes through the environment variables API with NETLIFY_AUTH_TOKEN instead:
 * https://open-api.netlify.com/#tag/environmentVariables
 */
export function netlifyEnv(context: HostEnvContext): HostEnv {
  const netlify = hostCli("netlify", "netlify-cli", context.root, context.env)
  const siteId = context.link.project.id ?? ""
  if (!siteId) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED({ host: "netlify" }), setupExitCodes.inputNeeded, { missing: [{ field: "project.id" }], rerun: "vitehub link --host netlify" })
  const deployContext = netlifyContexts[context.target]
  let accountId = context.link.account?.id

  async function api() {
    const credentials = await resolveHostCredentials("netlify", { cwd: context.root, env: context.env })
    if (!credentials.ok) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CREDENTIALS_MISSING({ fix: credentials.fix, host: "netlify" }), setupExitCodes.inputNeeded, { missing: credentials.missing.map(field => ({ field })) })
    const request = createNetlifyApiClient(credentials.token, context.fetch)
    if (!accountId) {
      const site = await request(`/sites/${encodeURIComponent(siteId)}`)
      accountId = isRecord(site) ? optionalString(site.account_id) : undefined
      if (!accountId) throw cliErrorDiagnostics.CLI_R0001({ message: "[vitehub] The Netlify API returned a site without account_id." })
    }
    return { path: `/accounts/${encodeURIComponent(accountId)}/env`, query: { site_id: siteId }, request }
  }

  return {
    async listSecretNames() {
      const result = await context.run(netlify[0], [...netlify.slice(1), "env:list", "--context", deployContext, "--scope", "functions", "--json", "--site", siteId], { cwd: context.root, env: context.env })
      if (result.exitCode !== 0) throw hostListFailed("netlify env:list", result, context.secrets)
      const value = lastJsonObject(result.stdout)
      if (!value) throw hostListFailed("netlify env:list printed no JSON", result, context.secrets)
      return Object.keys(value)
    },
    async setSecret(name, value, { secret }) {
      const { path, query, request } = await api()
      const existing = await request(`${path}/${encodeURIComponent(name)}`, { query }).catch((error: unknown) => {
        if (isProvisionRequestError(error) && error.status === 404) return undefined
        throw error
      })
      // PATCH cannot add a scope or promote a readable variable to a secret. Refuse before writing.
      if (existing !== undefined && (!isRecord(existing) || !Array.isArray(existing.scopes) || !existing.scopes.includes("functions") || (secret && existing.is_secret !== true))) {
        throw setupFailure(cliErrorDiagnostics.SETUP_ENV_VALUE_UNSUPPORTED({ host: "netlify", name, reason: "The existing variable must include Functions scope and, for a secret declaration, secret storage. Update its settings in Netlify before pushing." }), setupExitCodes.conflict)
      }
      // PATCH sets the value of one context and keeps the others. A new variable gets only this context.
      if (existing !== undefined) await request(`${path}/${encodeURIComponent(name)}`, { body: { context: deployContext, value }, method: "PATCH", query })
      else await request(path, { body: [{ is_secret: secret, key: name, scopes: ["functions"], values: [{ context: deployContext, value }] }], method: "POST", query })
    },
  }
}

const buildingStates = new Set(["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed", "retrying"])

function netlifyState(value: unknown): HostDeployment["state"] {
  if (value === "ready") return "ready"
  if (value === "error") return "error"
  if (value === "rejected") return "canceled"
  return typeof value === "string" && buildingStates.has(value) ? "building" : "unknown"
}

function parseNetlifyDeploys(value: unknown, published: string | undefined): HostDeployment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const id = isRecord(item) ? optionalString(item.id) : undefined
    if (!id || !isRecord(item)) return []
    // `netlify deploy --message` is the deploy `title`. A Git build has `commit_ref`.
    const marked = parseCommitMessage(item.title)
    const ref = optionalString(item.commit_ref)
    const commit: HostDeployment["commit"] = marked ? { ...marked, from: "vitehub" } : ref ? { dirty: false, from: "host", sha: ref } : undefined
    const url = optionalString(item.deploy_ssl_url) ?? optionalString(item.deploy_url)
    return [{
      createdAt: isoTime(item.created_at),
      id,
      live: id === published,
      source: marked ? "cli" : ref ? "git" : "unknown",
      state: netlifyState(item.state),
      target: item.context === "production" ? "production" : "preview",
      ...(url ? { url } : {}),
      ...(commit ? { commit } : {}),
    } satisfies HostDeployment]
  })
}

/**
 * Netlify API (https://open-api.netlify.com/), with the site id that `vitehub link` or the first `vitehub deploy` stored:
 * - `GET /api/v1/sites/{site_id}/deploys?per_page=`, newest first (`listSiteDeploys`).
 * - `GET /api/v1/sites/{site_id}`: `published_deploy.id` is the deploy that serves production (`getSite`).
 */
export const listNetlifyDeployments: ListDeployments = async (context, { limit, includeLive }) => {
  const siteId = context.link.project.id ?? ""
  if (!siteId) throw setupFailure(cliErrorDiagnostics.SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED({ host: "netlify" }), setupExitCodes.inputNeeded, { missing: [{ field: "project.id" }], rerun: "vitehub link --host netlify" })
  const client = createNetlifyApiClient(context.credentials.token, context.fetch)
  const path = `/sites/${encodeURIComponent(siteId)}`
  const [site, deploys] = await Promise.all([client(path), client(`${path}/deploys`, { query: { page: "1", per_page: String(limit) } })])
  const published = isRecord(site) && isRecord(site.published_deploy) ? optionalString(site.published_deploy.id) : undefined
  const recent = parseNetlifyDeploys(deploys, published).slice(0, limit)
  if (includeLive && published && !recent.some(item => item.live)) {
    const live = await client(`/deploys/${encodeURIComponent(published)}`)
    recent.push(...parseNetlifyDeploys([live], published))
  }
  return recent
}
