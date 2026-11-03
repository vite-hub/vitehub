// Boots a real WebContainer in headless Chromium through the built package, so it needs network access to StackBlitz.
// Run: pnpm --filter @vite-hub/web-container test:browser
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { hubWebContainer } from "../../dist/vite.js"

const port = Number(process.env.WEB_CONTAINER_TEST_PORT ?? 4793)
const root = fileURLToPath(new URL("./page", import.meta.url))
const distEntry = fileURLToPath(new URL("../../dist/index.js", import.meta.url))

// A Node http app with no dependencies. It reads its greeting from the per-process env.
const files = {
  "package.json": JSON.stringify({ name: "tiny", private: true, type: "module", scripts: { dev: "node server.js" } }),
  "server.js": [
    "import { createServer } from \"node:http\"",
    "createServer((request, response) => {",
    "  response.setHeader(\"content-type\", \"application/json\")",
    "  response.end(JSON.stringify({ greeting: process.env.GREETING, node: process.version, path: request.url }))",
    "}).listen(3000, () => console.log(\"listening on 3000\"))",
  ].join("\n"),
}

async function waitForFrame(page, url) {
  const origin = new URL(url).origin
  for (let attempt = 0; attempt < 600; attempt++) {
    const frame = page.frames().find(candidate => candidate.url().startsWith(origin))
    if (frame) return frame
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`No frame loaded ${url}`)
}

test("boots a WebContainer, runs a Node app, reads its preview, and remounts a snapshot", { timeout: 5 * 60_000 }, async (t) => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    plugins: [hubWebContainer({ routes: ["/**"] })],
    resolve: { alias: { "@vite-hub/web-container": distEntry } },
    root,
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  const browser = await chromium.launch({ args: ["--headless=new"] })
  t.after(async () => {
    await browser.close()
    await server.close()
  })

  const page = await browser.newPage()
  page.on("pageerror", error => console.log("[page error]", error.message))
  const started = performance.now()
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.webContainer)
  assert.equal(await page.evaluate(() => crossOriginIsolated), true, "the Vite plugin made the page cross-origin isolated")

  const first = await page.evaluate(async (files) => {
    const { bootWebContainer } = window.webContainer
    const statuses = []
    const container = await bootWebContainer({ files, workdirName: "tiny", onStatus: status => statuses.push(status.stage) })
    window.container = container

    const install = await container.run("install")
    const installExit = await install.exit
    const installOutput = await install.text()

    const dev = await container.run("dev", { env: { GREETING: "hello from the per-process env" } })
    const server = await container.preview.ready

    window.dev = dev
    return {
      installExit,
      installOutput: installOutput.slice(-300),
      port: server.port,
      previewUrl: server.url,
      stages: statuses,
      steps: container.status.steps.map(step => ({ stage: step.stage, ms: Math.round(step.ms ?? -1) })),
    }
  }, files)

  // The preview origin only answers inside a frame of the page that booted the container, like a docs preview pane.
  const previewStarted = performance.now()
  await page.evaluate((url) => {
    const frame = document.createElement("iframe")
    frame.src = new URL("/check", url).href
    document.body.append(frame)
  }, first.previewUrl)
  const frame = await waitForFrame(page, first.previewUrl)
  await frame.waitForFunction(() => document.body?.textContent?.includes("greeting"), undefined, { timeout: 60_000 })
  const body = JSON.parse(await frame.evaluate(() => document.body.textContent))
  const previewMs = Math.round(performance.now() - previewStarted)

  const exported = await page.evaluate(async () => {
    window.dev.kill()
    const snapshot = await window.container.export({ excludes: ["node_modules"] })
    return Array.from(snapshot)
  })

  console.log("first boot steps", JSON.stringify(first.steps))
  console.log("preview", first.previewUrl, "port", first.port, `read in ${previewMs} ms`, "snapshot bytes", exported.length)
  assert.equal(first.installExit, 0, first.installOutput)
  assert.deepEqual(body, { greeting: "hello from the per-process env", node: body.node, path: "/check" })
  assert.match(body.node, /^v22\./)
  assert.deepEqual(first.stages, ["checking", "booting", "mounting", "mounting", "installing", "installing", "starting", "ready"])

  const second = await page.evaluate(async (bytes) => {
    window.container.teardown()
    const { bootWebContainer } = window.webContainer
    const container = await bootWebContainer({ snapshot: new Uint8Array(bytes), files: { "extra.txt": "added after the snapshot" } })
    const result = {
      server: await container.fs.readFile("server.js", "utf-8"),
      extra: await container.fs.readFile("extra.txt", "utf-8"),
      steps: container.status.steps.map(step => ({ stage: step.stage, ms: Math.round(step.ms ?? -1) })),
    }
    container.teardown()
    return result
  }, exported)

  console.log("snapshot boot steps", JSON.stringify(second.steps))
  assert.equal(second.server, files["server.js"])
  assert.equal(second.extra, "added after the snapshot")
  console.log(`total ${Math.round(performance.now() - started)} ms`)
})
