import { execFileSync } from "node:child_process"
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import process from "node:process"

import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js"
import { blake2b } from "@noble/hashes/blake2.js"
import { describe, expect, it } from "vitest"

import { githubRepositoryFromRemote } from "../src/setup/deploy/github.ts"
import { createProject, runSetup } from "./setup-helpers.ts"

import type { SetupError } from "../src/setup/index.ts"
import type { EnvDiffOutput, EnvPushOutput } from "../src/setup/env.ts"

type DiffJson = EnvDiffOutput & { error?: SetupError, rerun?: string }
type PushJson = EnvPushOutput & { error?: SetupError, rerun?: string }

/** A value that must leave the CLI only sealed in a GitHub request body. */
const canary = "canary-gh-41d9e7a2c0"
const token = "ghp_testtoken0123456789"

const envEntries = [
  { names: ["VITEHUB_SECRET"], required: true, secret: true, hasDefault: false, owners: ["vite-hub"] },
  // GitHub reserves GITHUB_*, so only VITEHUB_GITHUB_TOKEN can be a GitHub secret.
  { path: "env.server.github.token", names: ["VITEHUB_GITHUB_TOKEN", "GITHUB_TOKEN"], required: true, secret: true, hasDefault: false },
  { path: "env.server.sentryDsn", names: ["SENTRY_DSN"], required: false, secret: false, hasDefault: false },
]

/** An X25519 key pair as raw 32-byte keys, as GitHub keeps the repository public key. */
function x25519KeyPair(): { publicKey: Uint8Array, privateKey: Uint8Array } {
  const pair = generateKeyPairSync("x25519")
  return {
    privateKey: Buffer.from(pair.privateKey.export({ format: "jwk" }).d ?? "", "base64url"),
    publicKey: Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url"),
  }
}

/** libsodium `crypto_box_seal_open`, written from the secret key side for the test. */
function sealOpen(sealed: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): string {
  const ephemeral = sealed.subarray(0, 32)
  const jwk = (key: Uint8Array) => Buffer.from(key).toString("base64url")
  const shared = diffieHellman({
    privateKey: createPrivateKey({ format: "jwk", key: { crv: "X25519", d: jwk(privateKey), kty: "OKP", x: jwk(publicKey) } }),
    publicKey: createPublicKey({ format: "jwk", key: { crv: "X25519", kty: "OKP", x: jwk(ephemeral) } }),
  })
  const sharedWords = new Uint32Array(8)
  for (let index = 0; index < 8; index++) sharedWords[index] = shared.readUInt32LE(index * 4)
  const keyWords = new Uint32Array(8)
  hsalsa(new Uint32Array([0x61707865, 0x3320646E, 0x79622D32, 0x6B206574]), sharedWords, new Uint32Array(4), keyWords)
  const key = Buffer.alloc(32)
  keyWords.forEach((word, index) => key.writeUInt32LE(word, index * 4))
  const nonce = blake2b(Buffer.concat([ephemeral, publicKey]), { dkLen: 24 })
  return new TextDecoder().decode(xsalsa20poly1305(key, nonce).decrypt(sealed.subarray(32)))
}

interface GitHubRequest {
  method: string
  path: string
  authorization: string | null
  body?: { encrypted_value: string, key_id: string }
}

/** The Actions secrets API of one repository and its environments. Stores sealed values, as GitHub does. */
function fakeGitHub(options: { secrets?: Record<string, string[]>, environments?: string[], appToken?: string } = {}) {
  const keys = x25519KeyPair()
  const stored: Record<string, Map<string, string>> = { "": new Map((options.secrets?.[""] ?? []).map(name => [name, ""])) }
  for (const environment of options.environments ?? []) stored[environment] = new Map((options.secrets?.[environment] ?? []).map(name => [name, ""]))
  const requests: GitHubRequest[] = []
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as GitHubRequest["body"] : undefined
    const authorization = new Headers(init?.headers).get("authorization")
    requests.push({ authorization, method, path: url.pathname + url.search, ...(body ? { body } : {}) })
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/u.test(url.pathname)) {
      return json({ expires_at: new Date(Date.now() + 3_600_000).toISOString(), token: options.appToken }, 201)
    }
    const match = /^\/repos\/acme\/web(?:\/environments\/([^/]+)|\/actions)\/secrets(?:\/(public-key|\w+))?$/u.exec(url.pathname)
    if (!match) return json({ message: "Not Found" }, 404)
    const secrets = stored[match[1] ? decodeURIComponent(match[1]) : ""]
    if (!secrets) return json({ message: "Not Found" }, 404)
    if (match[2] === "public-key") return json({ key: Buffer.from(keys.publicKey).toString("base64"), key_id: "key-123" })
    if (method === "GET" && !match[2]) return json({ secrets: [...secrets.keys()].map(name => ({ name })), total_count: secrets.size })
    if (method === "PUT" && match[2] && body) {
      const created = !secrets.has(match[2])
      secrets.set(match[2], sealOpen(Buffer.from(body.encrypted_value, "base64"), keys.publicKey, keys.privateKey))
      return new Response(null, { status: created ? 201 : 204 })
    }
    return json({ message: "unexpected" }, 400)
  }
  return { fetch, keys, requests, stored }
}

/** A linked Cloudflare project with a build and a GitHub remote, plus a `gh` on PATH that logs its calls. */
async function project(files: Record<string, string> = {}, remote = "git@github.com:acme/web.git") {
  const root = await createProject({
    "package.json": JSON.stringify({ name: "my-app", packageManager: "pnpm@10.0.0", scripts: { build: "vite build" }, type: "module" }),
    ".gitignore": ".output\n.vitehub\n.env*\n",
    ".vitehub/link.json": JSON.stringify({ default: "cloudflare", schemaVersion: 2, targets: { cloudflare: { account: { id: "acc-1" }, project: { name: "my-app" }, verified: true, linkedAt: "2026-11-15T00:00:00.000Z" } } }),
    ".output/deployment.json": JSON.stringify({ env: envEntries, host: "cloudflare", identity: { name: "my-app", source: "package" } }),
    ...files,
  })
  execFileSync("git", ["init", "-q"], { cwd: root, env: { ...process.env, LC_ALL: "C" } })
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root })
  // Outside the app, whose package.json has "type": "module": the fake gh is CommonJS.
  const bin = join(await createProject(), "bin")
  await mkdir(bin)
  const ghLog = join(dirname(bin), "gh-calls")
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")\nif (process.env.FAKE_GH_TOKEN) process.stdout.write(process.env.FAKE_GH_TOKEN + "\\n")\nelse { process.stderr.write("not logged in\\n"); process.exit(1) }\n`)
  await chmod(join(bin, "gh"), 0o755)
  const env: NodeJS.ProcessEnv = { LC_ALL: "C", PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) }
  const ghCalls = async () => (await readFile(ghLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
  return { env, ghCalls, root }
}

const local = {
  ".env": "SENTRY_DSN=https://sentry.example/1\n",
  ".env.production": `VITEHUB_SECRET=${canary}\nGITHUB_TOKEN=gh-from-file\n`,
}

describe("vitehub env --to github", () => {
  it("lists the repository secret names and diffs them, without GitHub's reserved names", async () => {
    const { env, root } = await project()
    const github = fakeGitHub({ secrets: { "": ["VITEHUB_SECRET", "OLD_DEPLOY_KEY"] } })
    const result = await runSetup<DiffJson>(["env", "diff", "--to", "github", "--json"], root, { ...env, GITHUB_TOKEN: token }, { fetch: github.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect(result.json).toEqual({
      extra: ["OLD_DEPLOY_KEY"],
      github: { repository: "acme/web" },
      host: "cloudflare",
      missing: {
        optional: [{ names: ["SENTRY_DSN"], path: "env.server.sentryDsn", secret: false }],
        required: [{ names: ["VITEHUB_GITHUB_TOKEN"], path: "env.server.github.token", secret: true }],
      },
      ok: false,
      project: "my-app",
      schemaVersion: 1,
      stage: "production",
    })
    expect(github.requests).toEqual([{ authorization: `Bearer ${token}`, method: "GET", path: "/repos/acme/web/actions/secrets?per_page=100&page=1" }])

    const text = await runSetup(["env", "diff", "--to", "github"], root, { ...env, GITHUB_TOKEN: token }, { fetch: github.fetch })
    expect(text.stdout).toContain("Run `vitehub env push --to github --repo acme/web` to set them")
  })

  it("seals each value with the repository public key, and GitHub's secret key opens it", async () => {
    const { env, root } = await project(local)
    const github = fakeGitHub({ secrets: { "": ["VITEHUB_SECRET"] } })
    const result = await runSetup<PushJson>(["env", "push", "--to", "github", "--yes", "--json"], root, { ...env, GITHUB_TOKEN: token, VITEHUB_GITHUB_TOKEN: "gh-from-shell" }, { fetch: github.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.pushed).toEqual([
      { name: "VITEHUB_SECRET", replaced: true, secret: true, source: ".env.production" },
      { name: "VITEHUB_GITHUB_TOKEN", replaced: false, secret: true, source: "process" },
      { name: "SENTRY_DSN", replaced: false, secret: false, source: ".env" },
    ])
    expect(github.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      "GET /repos/acme/web/actions/secrets?per_page=100&page=1",
      "GET /repos/acme/web/actions/secrets/public-key",
      "PUT /repos/acme/web/actions/secrets/VITEHUB_SECRET",
      "PUT /repos/acme/web/actions/secrets/VITEHUB_GITHUB_TOKEN",
      "PUT /repos/acme/web/actions/secrets/SENTRY_DSN",
    ])
    for (const request of github.requests.filter(item => item.method === "PUT")) {
      expect(Object.keys(request.body ?? {}).sort()).toEqual(["encrypted_value", "key_id"])
      expect(request.body?.key_id).toBe("key-123")
      expect(request.body?.encrypted_value).not.toContain(canary)
    }
    expect(Object.fromEntries(github.stored[""]!)).toEqual({ SENTRY_DSN: "https://sentry.example/1", VITEHUB_GITHUB_TOKEN: "gh-from-shell", VITEHUB_SECRET: canary })
    // The value is in no output, no argv, and the token never shows either.
    const output = result.stdout + result.stderr
    for (const value of [canary, "gh-from-shell", token]) expect(output).not.toContain(value)
    expect(JSON.stringify(github.requests.map(request => request.path))).not.toContain(canary)
  })

  it("writes environment secrets with --environment, and --repo overrides the remote", async () => {
    const { env, root } = await project(local, "https://github.com/someone/else.git")
    const github = fakeGitHub({ environments: ["staging"] })
    const result = await runSetup<PushJson>(["env", "push", "--to", "github", "--repo", "acme/web", "--environment", "staging", "--only", "VITEHUB_SECRET", "--yes", "--json"], root, { ...env, GH_TOKEN: token }, { fetch: github.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json).toMatchObject({ github: { environment: "staging", repository: "acme/web" }, pushed: [{ name: "VITEHUB_SECRET" }] })
    expect(github.requests.map(request => `${request.method} ${request.path}`)).toEqual([
      "GET /repos/acme/web/environments/staging/secrets?per_page=100&page=1",
      "GET /repos/acme/web/environments/staging/secrets/public-key",
      "PUT /repos/acme/web/environments/staging/secrets/VITEHUB_SECRET",
    ])
    expect(github.stored.staging!.get("VITEHUB_SECRET")).toBe(canary)

    const missing = await runSetup<PushJson>(["env", "push", "--to", "github", "--repo", "acme/web", "--environment", "nope", "--yes", "--json"], root, { ...env, GH_TOKEN: token }, { fetch: github.fetch })
    expect(missing.exitCode).toBe(1)
    expect(missing.json.error).toMatchObject({ code: "SETUP_GITHUB_REQUEST_FAILED" })
    expect(missing.json.error?.why).toContain("The environment nope may not exist")
  })

  it("resolves the token from GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`, then the GitHub App", async () => {
    const { env, ghCalls, root } = await project()
    const authorizations = async (extra: NodeJS.ProcessEnv) => {
      const github = fakeGitHub({ appToken: "ghs_app_installation" })
      const result = await runSetup<DiffJson>(["env", "diff", "--to", "github", "--json"], root, { ...env, ...extra }, { fetch: github.fetch })
      return { auth: github.requests.find(request => request.path.includes("/secrets"))?.authorization, result }
    }
    expect((await authorizations({ GH_TOKEN: "gh-env", GITHUB_TOKEN: "github-env" })).auth).toBe("Bearer github-env")
    expect((await authorizations({ FAKE_GH_TOKEN: "gh-cli", GH_TOKEN: "gh-env" })).auth).toBe("Bearer gh-env")
    expect(await ghCalls()).toEqual([])
    expect((await authorizations({ FAKE_GH_TOKEN: "gh-cli" })).auth).toBe("Bearer gh-cli")
    expect(await ghCalls()).toEqual([["auth", "token", "--hostname", "github.com"]])

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const app = await authorizations({ VITEHUB_GITHUB_APP_ID: "123", VITEHUB_GITHUB_APP_OWNER: "acme", VITEHUB_GITHUB_INSTALLATION_ID: "456", VITEHUB_GITHUB_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString() })
    expect(app.result.stderr, JSON.stringify(app.result.json)).not.toContain("ghs_app_installation")
    expect(app.result.json.error, JSON.stringify(app.result.json)).toBeUndefined()
    expect(app.auth).toBe("Bearer ghs_app_installation")

    const none = await authorizations({})
    expect(none.result.exitCode).toBe(2)
    expect(none.result.json.error).toMatchObject({ code: "SETUP_DEPLOY_CREDENTIALS_MISSING", fix: expect.stringContaining("gh auth login") })
  })

  it("needs a GitHub remote or --repo, and --repo needs --to github", async () => {
    const { env, root } = await project({}, "")
    const result = await runSetup<DiffJson>(["env", "diff", "--to", "github", "--json"], root, { ...env, GITHUB_TOKEN: token })
    expect(result.exitCode).toBe(2)
    expect(result.json.error).toMatchObject({ code: "SETUP_GITHUB_REPOSITORY_REQUIRED" })

    const repoWithoutTo = await runSetup<DiffJson>(["env", "diff", "--repo", "acme/web", "--json"], root, env)
    expect(repoWithoutTo.json.error?.why).toContain("--repo and --environment need --to github")
    const unknown = await runSetup<DiffJson>(["env", "diff", "--to", "gitlab", "--json"], root, env)
    expect(unknown.json.error?.why).toContain("The only destination is github")
  })

  it("reads owner/name from the remote URL forms", () => {
    expect(githubRepositoryFromRemote("git@github.com:acme/web.git")).toBe("acme/web")
    expect(githubRepositoryFromRemote("https://github.com/acme/web")).toBe("acme/web")
    expect(githubRepositoryFromRemote("https://x-access-token:abc@github.com/acme/web.git")).toBe("acme/web")
    expect(githubRepositoryFromRemote("ssh://git@github.com/acme/my.site.git")).toBe("acme/my.site")
    expect(githubRepositoryFromRemote("https://gitlab.com/acme/web.git")).toBeUndefined()
  })

  it("opens a sealed box that libsodium wrote, so the test decryptor matches crypto_box_seal", () => {
    // Written by PyNaCl 1.6.2 (libsodium) SealedBox(public_key).encrypt(b"libsodium-vector-value").
    const privateKey = Buffer.from("OWWfi7b+0/LJFQXO8fGyFVcPGRlbFJ5PirzsfqNhEhI=", "base64")
    const publicKey = Buffer.from("Mk9vP4bHNTWtrKv61I//sI89wKzy+5FTidrEuR6LsiI=", "base64")
    const sealed = Buffer.from("nAKyR0kJSVB4CIMJDx7e4VcLoaWwJRHFwACV2c+qY0fVUidpsnUAvHOFc01RhvRe1QgaPLPVFbLAumAA+nzH7QSwWrluWw==", "base64")
    expect(sealOpen(sealed, publicKey, privateKey)).toBe("libsodium-vector-value")
  })
})
