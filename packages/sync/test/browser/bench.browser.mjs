// Measures the Sync client with Vue in headless Chromium: 10,000 rows with one child component per row, the real
// IndexedDB storage, and the fake server inside the page, so no network time is in the numbers. It prints the median
// of each step over three page loads. Set SYNC_BENCH_OUT to a file path to also write the numbers as JSON.
// Run: pnpm --filter @vite-hub/sync test:browser
import { writeFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { build } from "vite"

const origin = "http://localhost:4872"
const sessions = 3

async function bundle(entry) {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), "__VUE_OPTIONS_API__": "true", "__VUE_PROD_DEVTOOLS__": "false", "__VUE_PROD_HYDRATION_MISMATCH_DETAILS__": "false" },
    build: { write: false, minify: true, lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: ["es"], fileName: "entry" } },
  })
  const [result] = Array.isArray(output) ? output : [output]
  return result.output.find(chunk => chunk.type === "chunk" && chunk.isEntry).code
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

test("the Sync bench: 10,000 rows in Vue", { timeout: 600_000 }, async (t) => {
  const app = await bundle("./bench-app.ts")
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const samples = {}
  for (let session = 0; session < sessions; session++) {
    const context = await browser.newContext()
    await context.route(`${origin}/**`, (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<script type="module" src="/app.js"></script>` })
      if (url.pathname === "/app.js") return route.fulfill({ contentType: "text/javascript", body: app })
      return route.fulfill({ status: 404, body: "" })
    })
    const page = await context.newPage()
    await page.goto(`${origin}/`)
    await page.waitForFunction(() => window.bench)
    const run = await page.evaluate(() => window.bench.run())
    // The rows are in IndexedDB now. A new page load paints them before any pull.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)))
    await page.reload()
    await page.waitForFunction(() => window.bench)
    const paint = await page.evaluate(() => window.bench.paint())
    for (const [step, value] of Object.entries({ ...run, ...paint })) (samples[step] ??= []).push(value)
    await context.close()
  }
  const result = Object.fromEntries(Object.entries(samples).map(([step, values]) => [step, Math.round(median(values) * 10) / 10]))
  console.table(result)
  if (process.env.SYNC_BENCH_OUT) await writeFile(process.env.SYNC_BENCH_OUT, `${JSON.stringify(result, null, 2)}\n`)
})
