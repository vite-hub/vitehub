import { existsSync } from "node:fs"

import { createNetlifyApiClient, ProvisionRequestError } from "@vite-hub/internal/provision"
import { join } from "pathe"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { commitMessage, hostCli, hostCliFailed, isRecord, lastJsonObject, optionalString } from "./host.ts"

import type { DeployAdapter, DeployContext } from "./host.ts"

interface NetlifySite {
  id: string
  accountId?: string
}

/** Nitro's Netlify preset writes static files to `dist` (`output.publicDir`). */
const publishDir = "dist"

/** Netlify contexts that read the Console hash: `--prod` deploys and draft deploys. */
const secretContexts = ["production", "deploy-preview"] as const

// Netlify CLI 27.11: `netlify deploy --help` and `netlify env:set --help`, recorded in test/fixtures/host-cli-help/.
// `env:set` takes the value as an argument, so the secret goes through the environment variables API instead:
// https://open-api.netlify.com/#tag/environmentVariables. The CLI reads NETLIFY_AUTH_TOKEN from the environment.
export function netlifyAdapter(context: DeployContext): DeployAdapter {
  const netlify = hostCli("netlify", "netlify-cli", context.root, context.env)
  const linked = context.link?.host === "netlify" && context.link.project.id ? context.link : undefined
  let site: NetlifySite | undefined = linked?.project.id ? { id: linked.project.id, ...(linked.account ? { accountId: linked.account.id } : {}) } : undefined

  const api = () => {
    if (!context.credentials.ok) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CREDENTIALS_MISSING({ fix: "Set NETLIFY_AUTH_TOKEN.", host: "netlify" }), setupExitCodes.inputNeeded)
    return createNetlifyApiClient(context.credentials.token, context.fetch)
  }

  /** The account of the site, which the environment variables API needs. */
  async function account(): Promise<{ accountId: string, siteId: string }> {
    if (!site) throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_OUTPUT_MISSING({ file: "the Netlify site id" }), setupExitCodes.error)
    if (!site.accountId) {
      const value = await api()(`/sites/${encodeURIComponent(site.id)}`)
      const accountId = isRecord(value) ? optionalString(value.account_id) : undefined
      if (!accountId) throw cliErrorDiagnostics.CLI_R0001({ message: "[vitehub] The Netlify API returned a site without account_id." })
      site = { ...site, accountId }
    }
    return { accountId: site.accountId!, siteId: site.id }
  }

  async function readVariable(name: string): Promise<unknown> {
    const { accountId, siteId } = await account()
    try {
      return await api()(`/accounts/${encodeURIComponent(accountId)}/env/${encodeURIComponent(name)}`, { query: { site_id: siteId } })
    }
    catch (error: unknown) {
      if (error instanceof ProvisionRequestError && error.status === 404) return
      throw error
    }
  }

  return {
    async deploy() {
      const args = ["deploy", "--no-build", "--dir", publishDir, "--json", ...(context.preview ? [] : ["--prod"])]
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
    async setSecret(name, value) {
      const { accountId, siteId } = await account()
      const values = secretContexts.map(deployContext => ({ context: deployContext, value }))
      const path = `/accounts/${encodeURIComponent(accountId)}/env`
      const body = { is_secret: true, key: name, scopes: ["functions"], values }
      if (await readVariable(name) === undefined) await api()(path, { body: [body], method: "POST", query: { site_id: siteId } })
      else await api()(`${path}/${encodeURIComponent(name)}`, { body, method: "PUT", query: { site_id: siteId } })
    },
    async hasSecret(name) {
      const value = await readVariable(name)
      return isRecord(value) && value.key === name
    },
    projectExists: async () => site !== undefined,
  }
}
