// A deploy while a tab is open: the tab runs build A, the server now runs build B, and the tab asks for a lazy chunk that
// only build A had. The check builds a Vite app and a Nuxt 5 app twice for Node, opens build A in headless Chromium,
// swaps the server to build B, and checks:
// - the failed chunk reloads the page once, into build B, and the lazy part then loads;
// - a chunk that build B misses too, within 10 seconds, does not reload again, so the page cannot loop;
// - a deploy that changes only the receipt's stylesheet reloads too. Nuxt cancels the event of a missing stylesheet
//   itself, and that is not an opt-out of the app.
// Run: pnpm --filter vite-hub exec node --test test/stale-chunk-reload.browser.mjs   (STALE_CHUNK_CASES=vite picks cases)
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, ".cache/stale-chunk-reload")
const hubOptions = { host: "node", console: false }

const cases = [
  { name: "vite", framework: "vite", port: 4851 },
  { name: "nuxt", framework: "nuxt", port: 4852 },
].filter(item => !process.env.STALE_CHUNK_CASES || process.env.STALE_CHUNK_CASES.split(",").includes(item.name))

const colors = { C: "rgb(200, 0, 0)", D: "rgb(0, 0, 200)" }

/**
 * The page shows its build, and the receipt view loads as a lazy chunk on a click. Builds C and D change only the
 * receipt's stylesheet: its JavaScript stays the same file.
 */
function appFiles(item, build) {
  const page = `<script setup lang="ts">\nimport { defineAsyncComponent, ref } from "vue"\n\nconst Receipt = defineAsyncComponent(() => import("./Receipt.vue"))\nconst open = ref(false)\n</script>\n\n<template>\n  <main>\n    <p id="build">Build ${build}</p>\n    <button id="open" @click="open = true">Show receipt</button>\n    <Receipt v-if="open" />\n  </main>\n</template>\n`
  const receipt = colors[build]
    ? `<template>\n  <p id="receipt">Receipt</p>\n</template>\n\n<style>\n#receipt { color: ${colors[build]}; }\n</style>\n`
    : `<template>\n  <p id="receipt">Receipt from build ${build}</p>\n</template>\n`
  if (item.framework === "vite") {
    return {
      "index.html": "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Orders</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
      "src/main.ts": "import { createApp } from \"vue\"\nimport App from \"./App.vue\"\n\ncreateApp(App).mount(\"#app\")\n",
      "src/App.vue": page,
      "src/Receipt.vue": receipt,
    }
  }
  return {
    "nuxt.config.ts": `export default defineNuxtConfig({\n  modules: ["vite-hub/nuxt"],\n  vitehub: ${JSON.stringify(hubOptions)},\n})\n`,
    "app/app.vue": page,
    "app/Receipt.vue": receipt,
  }
}

async function buildApp(item, root, build) {
  for (const [file, contents] of Object.entries({ "package.json": JSON.stringify({ name: `stale-chunk-${item.name}`, private: true, type: "module" }), ...appFiles(item, build) })) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  if (item.framework === "vite") {
    const { createBuilder } = await import("vite")
    const { default: vue } = await import("@vitejs/plugin-vue")
    const { vitehub } = await import("vite-hub")
    const builder = await createBuilder({ configFile: false, logLevel: "warn", plugins: [vue(), vitehub(hubOptions)], root })
    await builder.buildApp()
  }
  else {
    const { build: buildNuxt, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "warn" } })
    try {
      await buildNuxt(nuxt)
    }
    finally {
      await nuxt.close()
    }
  }
  const output = join(root, `build-${build}`)
  await rename(join(root, ".output"), output)
  return output
}

/** Starts a built app on the case's port. Resolves a function that stops it. */
async function start(item, output) {
  const origin = `http://127.0.0.1:${item.port}`
  const server = spawn(process.execPath, [join(output, "server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", NITRO_PORT: String(item.port), PORT: String(item.port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const logs = []
  server.stdout.on("data", chunk => logs.push(String(chunk)))
  server.stderr.on("data", chunk => logs.push(String(chunk)))
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      if ((await fetch(origin)).ok) break
    }
    catch {}
    if (Date.now() > deadline) throw new Error(`The app did not start at ${origin}.\n${logs.join("")}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return { origin, stop: () => new Promise(resolve => server.once("exit", resolve).kill()) }
}

/** The public files of a build, by extension. */
async function publicFiles(output, extension) {
  return (await readdir(join(output, "public"), { recursive: true })).filter(file => file.endsWith(extension)).sort()
}

/** The public file that holds the receipt of a build. */
async function receiptChunk(output, build) {
  const files = (await readdir(join(output, "public"), { recursive: true })).filter(file => file.endsWith(".js"))
  for (const file of files) {
    if ((await readFile(join(output, "public", file), "utf8")).includes(`Receipt from build ${build}`)) return join(output, "public", file)
  }
  throw new Error(`No chunk holds the receipt of build ${build}.`)
}

const browser = cases.length ? await chromium.launch() : undefined

for (const item of cases) {
  test(`${item.name}: a stale chunk after a deploy reloads the page once`, { timeout: 300_000 }, async () => {
    const root = join(fixtures, item.name)
    await rm(root, { force: true, recursive: true })
    const buildA = await buildApp(item, root, "A")
    const buildB = await buildApp(item, root, "B")
    assert.notEqual(await receiptChunk(buildA, "A").then(file => file.slice(buildA.length)), await receiptChunk(buildB, "B").then(file => file.slice(buildB.length)))

    let server = await start(item, buildA)
    const page = await browser.newPage()
    let loads = 0
    page.on("load", () => loads++)
    try {
      await page.goto(server.origin, { waitUntil: "networkidle" })
      await page.locator("#build").getByText("Build A").waitFor()
      // Nuxt prefetches lazy chunks, and a prefetched chunk stays in the HTTP cache. A tab that stays open for hours, or
      // an app with more chunks than it prefetches, asks the server again. Clear the cache to be that tab.
      await (await page.context().newCDPSession(page)).send("Network.clearBrowserCache")

      // The deploy: build B replaces build A behind the same address. The tab still runs build A.
      await server.stop()
      server = await start(item, buildB)

      await page.locator("#open").click()
      await page.locator("#build").getByText("Build B").waitFor({ timeout: 15_000 })
      // Server-rendered HTML shows the new build before its load event.
      await page.waitForLoadState("load")
      assert.equal(loads, 2)
      await page.locator("#open").click()
      await page.locator("#receipt").getByText("Receipt from build B").waitFor()

      // A chunk that the new build misses too must not reload again within 10 seconds.
      await page.reload()
      await page.locator("#build").getByText("Build B").waitFor()
      await rm(await receiptChunk(buildB, "B"))
      const before = loads
      await page.locator("#open").click()
      await page.waitForTimeout(2_000)
      assert.equal(loads, before)
    }
    finally {
      await page.close()
      await server.stop()
    }
  })
}

for (const item of cases) {
  test(`${item.name}: a stale stylesheet after a deploy reloads the page once`, { timeout: 300_000 }, async () => {
    const root = join(fixtures, `${item.name}-css`)
    await rm(root, { force: true, recursive: true })
    const buildC = await buildApp(item, root, "C")
    const buildD = await buildApp(item, root, "D")
    // The JavaScript of the receipt changes with its stylesheet. Serve the old JavaScript after the deploy too, so that
    // only the stylesheet fails.
    const scriptsC = await publicFiles(buildC, ".js")
    const [cssC, cssD] = await Promise.all([publicFiles(buildC, ".css"), publicFiles(buildD, ".css")])
    assert.notDeepEqual(cssC, cssD)

    let server = await start(item, buildC)
    const page = await browser.newPage()
    let loads = 0
    page.on("load", () => loads++)
    try {
      await page.goto(server.origin, { waitUntil: "networkidle" })
      await page.locator("#build").getByText("Build C").waitFor()
      await (await page.context().newCDPSession(page)).send("Network.clearBrowserCache")

      await server.stop()
      server = await start(item, buildD)
      await page.route("**/*.js", async (route) => {
        const file = scriptsC.find(name => new URL(route.request().url()).pathname.endsWith(`/${name.split("/").pop()}`))
        await (file ? route.fulfill({ contentType: "text/javascript", body: await readFile(join(buildC, "public", file)) }) : route.continue())
      })
      await page.locator("#open").click()
      await page.locator("#build").getByText("Build D").waitFor({ timeout: 15_000 })
      // Server-rendered HTML shows the new build before its load event.
      await page.waitForLoadState("load")
      assert.equal(loads, 2)
      await page.locator("#open").click()
      await page.locator("#receipt").waitFor()
      assert.equal(await page.locator("#receipt").evaluate(element => getComputedStyle(element).color), colors.D)
    }
    finally {
      await page.close()
      await server.stop()
    }
  })
}

test.after(async () => {
  await browser?.close()
})
