import { createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto"

import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js"
import { blake2b } from "@noble/hashes/blake2.js"

import { cliErrorDiagnostics } from "../../error-diagnostics.ts"
import { SetupFailure, setupExitCodes } from "../envelope.ts"
import { redact } from "./host.ts"

import type { DeployRun, HostEnv } from "./host.ts"

/** Where `vitehub env push --to github` writes: the Actions secrets of a repository, or of one of its environments. */
export interface GitHubEnvDestination {
  /** `owner/name`. */
  repository: string
  /** A GitHub deployment environment. Without it, the repository secrets. */
  environment?: string
}

const apiBase = "https://api.github.com"
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u

/** GitHub accepts letters, digits, and `_`, not a digit first, and reserves the `GITHUB_` prefix. */
export function isGitHubSecretName(name: string): boolean {
  return /^[A-Z_]\w*$/iu.test(name) && !/^GITHUB_/iu.test(name)
}

/** The `owner/name` of a GitHub remote URL: HTTPS, `git@github.com:`, or `ssh://`. */
export function githubRepositoryFromRemote(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(url.trim())
  return match?.[1]
}

/** `--repo`, else the GitHub repository of the git remote `origin`. */
export async function resolveGitHubRepository(repo: string | undefined, options: { root: string, env: NodeJS.ProcessEnv, run: DeployRun }): Promise<string> {
  if (repo !== undefined) {
    if (!repositoryPattern.test(repo)) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --repo ${JSON.stringify(repo)} is not owner/name.` })
    return repo
  }
  const result = await options.run("git", ["remote", "get-url", "origin"], { cwd: options.root, env: options.env }).catch(() => undefined)
  const remote = result?.exitCode === 0 ? result.stdout.trim() : undefined
  const repository = remote ? githubRepositoryFromRemote(remote) : undefined
  if (!repository) throw new SetupFailure(cliErrorDiagnostics.SETUP_GITHUB_REPOSITORY_REQUIRED({ remote: remote ?? "" }), setupExitCodes.inputNeeded, { missing: [{ field: "repo" }] })
  return repository
}

/**
 * A token that can write Actions secrets, in this order: `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth token`, then an
 * installation token of the GitHub App that `@vite-hub/forge` reads (`VITEHUB_GITHUB_APP_ID`).
 */
export async function resolveGitHubToken(repository: string, options: { root: string, env: NodeJS.ProcessEnv, run: DeployRun, fetch: typeof fetch }): Promise<string> {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const token = options.env[name]?.trim()
    if (token) return token
  }
  // No shell: `gh` gets an argument array. A machine without gh rejects with ENOENT.
  const gh = await options.run("gh", ["auth", "token", "--hostname", "github.com"], { cwd: options.root, env: options.env }).catch(() => undefined)
  const ghToken = gh?.exitCode === 0 ? gh.stdout.trim() : ""
  if (ghToken) return ghToken
  if (options.env.VITEHUB_GITHUB_APP_ID?.trim()) {
    // An optional peer: apps with a GitHub App have it through `vite-hub`.
    const forge = await import("@vite-hub/forge").catch(() => undefined)
    if (!forge) {
      throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CREDENTIALS_MISSING({ fix: "Install @vite-hub/forge to use the GitHub App of VITEHUB_GITHUB_APP_ID, or set GITHUB_TOKEN.", host: "GitHub" }), setupExitCodes.inputNeeded, { missing: [{ field: "GITHUB_TOKEN" }] })
    }
    const [error, token] = await forge.useForge({ env: options.env, fetch: options.fetch }).token({ repository })
    if (error) throw new SetupFailure(cliErrorDiagnostics.SETUP_GITHUB_REQUEST_FAILED({ operation: `GitHub App token for ${repository}`, reason: error.message }), setupExitCodes.error)
    return token.token
  }
  throw new SetupFailure(cliErrorDiagnostics.SETUP_DEPLOY_CREDENTIALS_MISSING({
    fix: "Set GITHUB_TOKEN or GH_TOKEN to a token that can write the Actions secrets of the repository, run `gh auth login`, or set VITEHUB_GITHUB_APP_ID and the private key of a GitHub App that is installed on it.",
    host: "GitHub",
  }), setupExitCodes.inputNeeded, { missing: [{ field: "GITHUB_TOKEN" }] })
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** "expand 32-byte k" as little-endian words. */
const sigma = new Uint32Array([0x61707865, 0x3320646E, 0x79622D32, 0x6B206574])

function words(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Uint32Array.from({ length: bytes.length / 4 }, (_, index) => view.getUint32(index * 4, true))
}

function wordBytes(input: Uint32Array): Uint8Array {
  const out = new Uint8Array(input.length * 4)
  const view = new DataView(out.buffer)
  input.forEach((word, index) => view.setUint32(index * 4, word, true))
  return out
}

/** `crypto_box_beforenm`: HSalsa20 of the X25519 shared secret with a zero input. */
function boxKey(shared: Uint8Array): Uint8Array {
  const out = new Uint32Array(8)
  hsalsa(sigma, words(shared), new Uint32Array(4), out)
  return wordBytes(out)
}

function x25519PublicKey(raw: Uint8Array) {
  return createPublicKey({ format: "jwk", key: { crv: "X25519", kty: "OKP", x: Buffer.from(raw).toString("base64url") } })
}

/**
 * libsodium `crypto_box_seal`, the encryption that GitHub wants for secrets: an ephemeral X25519 key pair,
 * nonce = BLAKE2b-192(ephemeral public key || recipient public key), XSalsa20-Poly1305. Output: ephemeral public key, tag, ciphertext.
 */
export function sealSecret(value: string, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeral = generateKeyPairSync("x25519")
  const ephemeralPublicKey = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x ?? "", "base64url")
  const nonce = blake2b(concat(ephemeralPublicKey, recipientPublicKey), { dkLen: 24 })
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519PublicKey(recipientPublicKey) })
  return concat(ephemeralPublicKey, xsalsa20poly1305(boxKey(shared), nonce).encrypt(new TextEncoder().encode(value)))
}

interface GitHubEnvContext extends GitHubEnvDestination {
  token: string
  fetch: typeof fetch
  /** Values that no error may show. */
  secrets: readonly string[]
}

/** The Actions secrets of a repository or environment, through the GitHub REST API. Values go only in a sealed request body. */
export function githubEnv(context: GitHubEnvContext): HostEnv {
  const [owner, name] = context.repository.split("/") as [string, string]
  const base = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${context.environment ? `/environments/${encodeURIComponent(context.environment)}` : "/actions"}/secrets`

  async function request(method: "GET" | "PUT", path: string, body?: object): Promise<unknown> {
    const response = await context.fetch(`${base}${path}`, {
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${context.token}`,
        "user-agent": "vitehub",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (response.ok) return response.status === 204 || response.status === 201 ? undefined : await response.json()
    const text = await response.text().catch(() => "")
    const message = /"message"\s*:\s*"([^"]*)"/u.exec(text)?.[1] ?? text.slice(0, 200)
    const operation = `${method} ${new URL(`${base}${path}`).pathname}`
    const hint = response.status === 404 && context.environment
      ? ` The environment ${context.environment} may not exist: create it in the repository settings.`
      : response.status === 404 || response.status === 403 ? " The token needs write access to the repository secrets." : ""
    throw new SetupFailure(cliErrorDiagnostics.SETUP_GITHUB_REQUEST_FAILED({ operation, reason: `${response.status} ${redact(message, [...context.secrets, context.token])}.${hint}` }), setupExitCodes.error)
  }

  let publicKey: Promise<{ key_id: string, key: Uint8Array }> | undefined
  return {
    async listSecretNames() {
      const names: string[] = []
      for (let page = 1; ; page++) {
        const body = await request("GET", `?per_page=100&page=${page}`) as { total_count?: number, secrets?: { name: string }[] }
        const secrets = body.secrets ?? []
        names.push(...secrets.map(secret => secret.name))
        if (!secrets.length || names.length >= (body.total_count ?? 0)) return names
      }
    },
    async setSecret(secretName, value) {
      publicKey ??= (request("GET", "/public-key") as Promise<{ key_id: string, key: string }>).then(body => ({ key: Buffer.from(body.key, "base64"), key_id: body.key_id }))
      const { key, key_id } = await publicKey
      const encrypted = Buffer.from(sealSecret(value, key)).toString("base64")
      await request("PUT", `/${encodeURIComponent(secretName)}`, { encrypted_value: encrypted, key_id })
    },
  }
}
