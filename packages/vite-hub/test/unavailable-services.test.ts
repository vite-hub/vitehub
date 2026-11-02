import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuilder } from "vite"
import { describe, expect, it } from "vitest"

import { vitehub, type ViteHubOptions } from "../src/index.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

// One server route imports Browser and Realtime, whether or not vitehub() enables them.
const route = [
  "import { isBrowserAvailable, runBrowserAction } from 'vite-hub/browser/actions'",
  "import { isRealtimeAvailable, refreshRealtimeDocument } from 'vite-hub/realtime/server'",
  "",
  "export default async () => {",
  "  const response = await runBrowserAction('content', { html: '<p>hi</p>' })",
  "  return {",
  "    browser: { available: isBrowserAvailable(), status: response.status, error: (await response.json()).error },",
  "    realtime: { available: isRealtimeAvailable(), refreshed: await refreshRealtimeDocument('docs', 'a.md') },",
  "  }",
  "}",
  "",
].join("\n")

async function buildApp(options: ViteHubOptions) {
  const root = await createProject({
    "index.html": "<!doctype html><html><body>ok</body></html>\n",
    "package.json": JSON.stringify({ name: `unavailable-${options.preset}`, private: true, type: "module" }),
    "server/routes/services.ts": route,
    "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
  })
  const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
  const builder = await createBuilder({
    cacheDir: `${root}.vite-cache`,
    logLevel: "silent",
    plugins: [vitehub({ console: false, env: false, ...options }), nitro() as never],
    root,
  } as never)
  await builder.buildApp()
  return root
}

async function readServerOutput(directory: string): Promise<string> {
  const files = await readdir(directory, { recursive: true })
  const chunks = await Promise.all(files.filter(file => file.endsWith(".mjs")).map(file => readFile(join(directory, file), "utf8")))
  return chunks.join("\n")
}

async function callServices(root: string) {
  const server = await startBuiltServer(root, {})
  try {
    return await (await server.fetch("/services")).json()
  }
  finally {
    server.close()
  }
}

describe("services that a build does not enable", () => {
  it.each([
    { preset: "cloudflare", output: ".output/server", reason: "vitehub() does not enable Browser." },
    { preset: "deno", output: ".output/server", reason: "Deno Deploy has no built-in Browser Provider." },
    { preset: "netlify", output: ".netlify", reason: "Netlify has no built-in Browser Provider." },
    { preset: "vercel", output: ".vercel/output/functions", reason: "Vercel has no built-in Browser Provider." },
  ] as const)("builds for $preset and bundles why Browser is off", async ({ output, preset, reason }) => {
    const root = await buildApp({ preset })
    expect(await readServerOutput(join(root, output))).toContain(reason)
  }, 120_000)

  it("answers calls with the preset and the fix in a built Node server", async () => {
    const root = await buildApp({ preset: "node" })

    expect(await callServices(root)).toEqual({
      browser: {
        available: false,
        error: {
          code: "BROWSER_UNAVAILABLE",
          details: {
            fix: "Deploy with the Cloudflare preset and set `browser: true` in vitehub().",
            preset: "node",
            reason: "The Node preset has no built-in Browser Provider.",
          },
          message: "[vitehub:browser] Browser is not available on the node preset. The Node preset has no built-in Browser Provider. Deploy with the Cloudflare preset and set `browser: true` in vitehub().",
        },
        status: 500,
      },
      realtime: { available: false, refreshed: false },
    })
  }, 120_000)

  it("reports Realtime as available when the build has a room authority", async () => {
    const root = await buildApp({ preset: "node", realtime: { authority: "memory" } })

    expect(await callServices(root)).toMatchObject({ realtime: { available: true, refreshed: false } })
  }, 120_000)
})
