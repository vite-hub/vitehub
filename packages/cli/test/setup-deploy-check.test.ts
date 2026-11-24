import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { rollbackFor, runDeployChecks, submitIndexNow } from "../src/setup/deploy/after.ts"
import { wranglerTargetUrl } from "../src/setup/deploy/cloudflare.ts"
import { builtProject, fakeHosts } from "./setup-deploy-helpers.ts"
import { runSetup } from "./setup-helpers.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { SetupDeployOutput, SetupError } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError }

const ACCOUNT = "023e105f4ecef8ad9ca31a8372d0c353"
const cloudflareEnv = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "cf-token-1" }
const cloudflareLink = { account: { id: ACCOUNT }, host: "cloudflare", linkedAt: "2026-11-06T00:00:00.000Z", project: { name: "my-app" }, schemaVersion: 1, verified: true }

interface Recorded { method: string, path: string, body: string }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function localSite(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<{ origin: string, requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8").on("data", (chunk: string) => { body += chunk }).on("end", () => {
      requests.push({ body, method: request.method ?? "GET", path: request.url ?? "/" })
      handler(request, response, body)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { origin: `http://127.0.0.1:${address.port}`, requests }
}

function routedFetch(local: string, origins: readonly string[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (origins.includes(url.origin)) return await fetch(`${local}${url.pathname}${url.search}`, init)
    const script = `/client/v4/accounts/${ACCOUNT}/workers/scripts/my-app`
    const fixtures: Record<string, string> = {
      [`${script}/deployments`]: "cloudflare-deployments.json",
      [`${script}/versions`]: "cloudflare-versions.json",
      [`${script}/versions/18f97339-c287-4872-9bdd-e2135c07ec12`]: "cloudflare-version.json",
      [`${script}/subdomain`]: "cloudflare-script-subdomain.json",
      [`/client/v4/accounts/${ACCOUNT}/workers/subdomain`]: "cloudflare-subdomain.json",
    }
    const fixture = url.origin === "https://api.cloudflare.com" ? fixtures[url.pathname] : undefined
    if (!fixture) throw new Error(`unexpected request to ${url.href}`)
    return new Response(await readFile(join(import.meta.dirname, "fixtures/host-api", fixture), "utf8"), { headers: { "content-type": "application/json" } })
  }
}

function wranglerConfig(config: object): Record<string, string> {
  return { ".output/server/wrangler.json": JSON.stringify({ main: "index.mjs", name: "my-app", ...config }) }
}

function manifest(deploy: object): Record<string, string> {
  return { ".output/deployment.json": JSON.stringify({ deploy, host: "cloudflare", identity: { name: "my-app", source: "package" } }) }
}

describe("deploy checks", () => {
  it("passes a path that answers 2xx after a retry, and fails one that never does", async () => {
    let healthCalls = 0
    const site = await localSite((request, response) => {
      if (request.url === "/_vitehub/health") {
        healthCalls++
        response.writeHead(healthCalls === 1 ? 503 : 200).end("{}")
        return
      }
      if (request.url === "/old") return void response.writeHead(301, { location: "/" }).end()
      response.writeHead(request.url === "/" ? 200 : 404).end("page")
    })
    const checks = await runDeployChecks(site.origin, ["/_vitehub/health", "/old", "/missing"], fetch, [0, 0])
    expect(checks).toEqual([
      { ok: true, path: "/_vitehub/health", status: 200, url: `${site.origin}/_vitehub/health` },
      { ok: true, path: "/old", status: 200, url: `${site.origin}/old` },
      { ok: false, path: "/missing", status: 404, url: `${site.origin}/missing` },
    ])
    expect(site.requests.filter(request => request.path === "/missing")).toHaveLength(3)
  })

  it("reports a server that does not answer", async () => {
    const site = await localSite((_request, response) => response.end())
    servers.pop()!.close()
    const [check] = await runDeployChecks(site.origin, ["/"], fetch, [])
    expect(check).toMatchObject({ ok: false, path: "/" })
    expect(check!.error).toBeTypeOf("string")
  })

  it("names the rollback command of each host", () => {
    const previous = { createdAt: "", id: "dep-1", live: true, source: "cli", state: "ready", target: "production", version: "ver-1" } as const
    expect(rollbackFor("cloudflare", { previous, projectName: "my-app" }).command).toBe("npx wrangler rollback ver-1 --name my-app --yes")
    expect(rollbackFor("vercel", { previous, projectName: "my-app" }).command).toBe("npx vercel rollback dep-1 --yes")
    expect(rollbackFor("netlify", { previous, projectName: "my-app", siteId: "site-1" }).command).toBe(`npx netlify api restoreSiteDeploy --data '{"deploy_id":"dep-1","site_id":"site-1"}'`)
    expect(rollbackFor("deno", { previous, projectName: "my-app" })).toMatchObject({ note: expect.stringContaining("Promote revision dep-1"), previous: { deploymentId: "dep-1" } })
    expect(rollbackFor("cloudflare", { previous: undefined, projectName: "my-app" }).note).toContain("first production deploy")
    expect(rollbackFor("cloudflare", { lookupFailed: "the host timed out.", previous: undefined, projectName: "my-app" }).note).toContain("not known: the host timed out.")
  })
})

describe("IndexNow", () => {
  const key = "0123456789abcdef0123456789abcdef"

  it("sends the URLs of every sitemap of a sitemap index, once, and only of the site", async () => {
    const site = await localSite((request, response) => {
      const origin = "https://shop.example.com"
      const bodies: Record<string, string> = {
        "/sitemap.xml": `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap><sitemap><loc>https://cdn.example.com/other.xml</loc></sitemap></sitemapindex>`,
        "/sitemap-pages.xml": `<urlset><url><loc>${origin}/</loc></url><url><loc> ${origin}/products?a=1&amp;b=2 </loc></url><url><loc>${origin}/</loc></url><url><loc>https://other.example.com/x</loc></url><url><loc><![CDATA[${origin}/guides?x=1&y=2]]></loc></url><url><loc>${origin}/search?a=1&#38;b=2&#x26;c=3</loc></url></urlset>`,
      }
      if (request.url === "/indexnow") return void response.writeHead(202).end()
      const body = bodies[request.url ?? ""]
      response.writeHead(body ? 200 : 404).end(body ?? "")
    })
    const routed: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      return await fetch(url.origin === "https://api.indexnow.org" ? `${site.origin}/indexnow` : `${site.origin}${url.pathname}`, init)
    }
    expect(await submitIndexNow({ key, url: "https://shop.example.com" }, routed)).toEqual({ status: 202, submitted: 4 })
    const submission = site.requests.find(request => request.path === "/indexnow")!
    expect(submission.method).toBe("POST")
    expect(JSON.parse(submission.body)).toEqual({
      host: "shop.example.com",
      key,
      keyLocation: `https://shop.example.com/${key}.txt`,
      urlList: ["https://shop.example.com/", "https://shop.example.com/products?a=1&b=2", "https://shop.example.com/guides?x=1&y=2", "https://shop.example.com/search?a=1&b=2&c=3"],
    })
    expect(site.requests.some(request => request.path === "/other.xml")).toBe(false)
  })

  it("says why nothing was sent", async () => {
    const missing = await localSite((_request, response) => response.writeHead(404).end())
    expect(await submitIndexNow({ key, url: missing.origin }, fetch)).toEqual({ error: `The sitemap could not be read: ${missing.origin}/sitemap.xml answered 404.`, status: 404 })

    const forbidden = await localSite((request, response) => {
      if (request.url === "/indexnow") return void response.writeHead(403).end()
      response.end(`<urlset><url><loc>https://shop.example.com/</loc></url></urlset>`)
    })
    const routed: typeof fetch = async (input, init) => await fetch(String(input).startsWith("https://api.indexnow.org") ? `${forbidden.origin}/indexnow` : `${forbidden.origin}/sitemap.xml`, init)
    expect(await submitIndexNow({ key, url: "https://shop.example.com" }, routed)).toEqual({ error: `IndexNow did not find the key file at https://shop.example.com/${key}.txt.`, status: 403 })
  })
})

describe("the URL of a Wrangler deploy", () => {
  it.each([
    { targets: ["https://my-app.example.workers.dev"], url: "https://my-app.example.workers.dev" },
    { targets: ["example.com (custom domain)", "www.example.com (custom domain)", "schedule: */5 * * * *"], url: "https://example.com" },
    { targets: ["https://my-app.example.workers.dev", "example.com (custom domain)"], url: "https://my-app.example.workers.dev" },
    { targets: ["example.com (custom domain - zone id: 023e105f4ecef8ad9ca31a8372d0c353)"], url: "https://example.com" },
    { targets: ["example.com (custom domain - zone name: example.com)"], url: "https://example.com" },
    { targets: ["preview.example.com (custom domain) [production: disabled, previews: enabled]", "example.com (custom domain) [production: enabled, previews: disabled]"], url: "https://example.com" },
    { targets: ["example.com/*", "example.com/api/* (zone name: example.com)", "example.com (custom domain)"], url: "https://example.com" },
    { targets: ["example.com/*", "*.example.com/* (zone name: example.com)", "...and 3 more routes"], url: undefined },
    { targets: ["https://*.example.com/*", "https://example.com/api/* (zone name: example.com)", "https://example.com/*"], url: undefined },
    { targets: ["https://example.com/* (zone name: example.com)", "https://my-app.example.workers.dev"], url: "https://my-app.example.workers.dev" },
    { targets: ["schedule: */5 * * * *", "Consumer for orders", "Producer for orders", "workflow: checkout", "event triggers: 1"], url: undefined },
    { targets: [], url: undefined },
  ])("finds $url in $targets", ({ targets, url }) => {
    expect(wranglerTargetUrl(targets)).toBe(url)
  })
})

describe("vitehub deploy with deploy.check", () => {
  it("checks the deployed URL and sends the sitemap to IndexNow after a production deploy", async () => {
    const site = await localSite((request, response) => {
      if (request.url === "/sitemap.xml") return void response.end("<urlset><url><loc>https://shop.example.com/</loc></url></urlset>")
      if (request.url === "/indexnow") return void response.writeHead(200).end()
      response.writeHead(200).end("ok")
    })
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/_vitehub/health", "/"], indexNow: { key: "0123456789abcdef0123456789abcdef", url: "https://shop.example.com" } }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const hosts = await fakeHosts(cloudflareEnv)
    const fetchImpl: typeof fetch = async (input, init) => String(input).startsWith("https://api.indexnow.org") ? await fetch(`${site.origin}/indexnow`, init) : await routedFetch(site.origin, ["https://my-app.example.workers.dev", "https://shop.example.com"])(input, init)
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--yes", "--json"], root, hosts.env, { fetch: fetchImpl })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.checks).toEqual([
      { ok: true, path: "/_vitehub/health", status: 200, url: "https://my-app.example.workers.dev/_vitehub/health" },
      { ok: true, path: "/", status: 200, url: "https://my-app.example.workers.dev/" },
    ])
    expect(result.json.indexNow).toEqual({ status: 200, submitted: 1 })
    expect(result.json.rollback).toBeUndefined()

    const text = await runSetup(["deploy", "--no-build", "--no-provision", "--no-index-now", "--yes"], root, hosts.env, { fetch: fetchImpl })
    expect(text.exitCode, text.stderr).toBe(0)
    expect(text.stdout).toContain("Checked /_vitehub/health: 200\nChecked /: 200\n")
    expect(site.requests.filter(request => request.path === "/indexnow")).toHaveLength(1)
   }, 30_000)

  it("fails with the rollback command of the deployment it replaced when a path does not answer 2xx", async () => {
    const site = await localSite((request, response) => {
      response.writeHead(request.url === "/" ? 200 : 503).end("down")
    })
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/", "/_vitehub/health"], indexNow: { key: "0123456789abcdef0123456789abcdef", url: "https://shop.example.com" } }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--yes", "--json"], root, hosts.env, { fetch: routedFetch(site.origin, ["https://my-app.example.workers.dev"]) })

    expect(result.exitCode).toBe(1)
    expect(result.json.error).toMatchObject({ code: "SETUP_DEPLOY_CHECK_FAILED" })
    expect(result.json.error?.why).toBe("The app is deployed to https://my-app.example.workers.dev, but a `deploy.check` path did not answer with a 2xx status: /_vitehub/health: 503.")
    expect(result.json.error?.fix).toContain("Run `npx wrangler rollback bcf48806-b317-4351-9ee7-36e7d557d4de --name my-app --yes` to put the previous deployment back on production.")
    expect(result.json.rollback).toEqual({
      command: "npx wrangler rollback bcf48806-b317-4351-9ee7-36e7d557d4de --name my-app --yes",
      previous: { deploymentId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", version: "bcf48806-b317-4351-9ee7-36e7d557d4de" },
    })
    expect(result.json.url).toBe("https://my-app.example.workers.dev")
    expect(result.json.indexNow).toBeUndefined()
    expect((await hosts.calls()).filter(call => call.argv[0] === "deploy")).toHaveLength(1)

    const skipped = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--no-check", "--no-index-now", "--yes", "--json"], root, hosts.env, { fetch: routedFetch(site.origin, ["https://my-app.example.workers.dev"]) })
    expect(skipped.exitCode, skipped.stdout).toBe(0)
    expect(skipped.json.checks).toBeUndefined()
  }, 30_000)

  it("checks the first custom domain of a Worker without workers.dev", async () => {
    const site = await localSite((_request, response) => response.writeHead(200).end("ok"))
    const routes = [{ custom_domain: true, pattern: "example.com" }, { custom_domain: true, pattern: "www.example.com" }]
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/_vitehub/health"] }), ...wranglerConfig({ routes, triggers: { crons: ["*/5 * * * *"] }, workers_dev: false }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--yes", "--json"], root, hosts.env, { fetch: routedFetch(site.origin, ["https://example.com"]) })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.url).toBe("https://example.com")
    expect(result.json.checks).toEqual([{ ok: true, path: "/_vitehub/health", status: 200, url: "https://example.com/_vitehub/health" }])
    expect(site.requests.map(request => request.path)).toEqual(["/_vitehub/health"])
  }, 30_000)

  it("skips the checks and IndexNow with a warning when the Worker has only route patterns", async () => {
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/_vitehub/health"], indexNow: { key: "0123456789abcdef0123456789abcdef", url: "https://shop.example.com" } }), ...wranglerConfig({ routes: [{ pattern: "example.com/*", zone_name: "example.com" }], triggers: { crons: ["*/5 * * * *"] } }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const hosts = await fakeHosts(cloudflareEnv)
    const fetchImpl: typeof fetch = async input => { throw new Error(`unexpected request to ${String(input)}`) }
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--yes", "--json"], root, hosts.env, { fetch: fetchImpl })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.url).toBeUndefined()
    expect(result.json.checks).toBeUndefined()
    expect(result.json.indexNow).toBeUndefined()
    expect(result.json.version).toBe("version-1")
    expect(result.stderr).toContain("Deploy checks skipped: cloudflare reported no URL to request, such as a workers.dev URL or a custom domain, so nothing is sent to IndexNow. The deploy is done.\n")

    const text = await runSetup(["deploy", "--no-build", "--no-provision", "--yes"], root, hosts.env, { fetch: fetchImpl })
    expect(text.exitCode, text.stderr).toBe(0)
    expect(text.stdout).toBe("Deployed my-app to cloudflare.\nVersion: version-2\n")
  }, 30_000)

  it("fails when Wrangler reports no URL for a preview or writes no output entry", async () => {
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/"] }), ...wranglerConfig({ preview_urls: false, workers_dev: false }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const preview = await runSetup<DeployJson>(["deploy", "--preview", "--no-build", "--no-provision", "--yes", "--json"], root, (await fakeHosts(cloudflareEnv)).env)
    expect(preview.exitCode).toBe(1)
    expect(preview.json.error?.why).toContain("wrangler versions upload printed no URL")

    const production = await runSetup<DeployJson>(["deploy", "--no-build", "--no-provision", "--yes", "--json"], root, (await fakeHosts({ ...cloudflareEnv, FAKE_HOST_NO_OUTPUT: "1" })).env)
    expect(production.exitCode).toBe(1)
    expect(production.json.error?.why).toContain("wrangler deploy printed no URL")
  }, 30_000)

  it("says that production did not change when a preview fails its check", async () => {
    const site = await localSite((_request, response) => response.writeHead(500).end())
    const root = await builtProject("cloudflare", { ...manifest({ check: ["/"] }), ".vitehub/link.json": JSON.stringify(cloudflareLink) })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup<DeployJson>(["deploy", "--preview", "--no-build", "--no-provision", "--yes", "--json"], root, hosts.env, { fetch: routedFetch(site.origin, ["https://v1-my-app.example.workers.dev"]) })
    expect(result.exitCode).toBe(1)
    expect(result.json.rollback).toEqual({ note: "This was a preview deploy, so production did not change." })
  }, 30_000)
})
