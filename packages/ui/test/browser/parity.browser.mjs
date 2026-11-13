// Behavior parity of the headless parts across engines, in headless Chromium.
// Each engine renders one fixture per component (`parity/<engine>/<component>.vue`, registered in `parity/engines.ts`),
// and `parity/scripts/<component>.mjs` drives every engine through the same keyboard and pointer steps. After each step
// the check records the accessibility tree, the focused element, the live regions and the ARIA relations.
//
// - Every engine must match its snapshot in `parity/snapshots/<component>.<engine>.json`.
// - Every engine must match the `reka` engine step by step, except for the entries of `parity/allowed-differences.json`:
//   `{ "component", "engine", "step", "field", "reason" }`, where `field` is `focus`, `tree`, `live` or `relations`.
//
// Run: pnpm --filter @vite-hub/ui test:parity
// Set PARITY_UPDATE=1 to write the snapshots instead of checking them.
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import vue from "@vitejs/plugin-vue"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const reference = "reka"
const fields = ["focus", "tree", "live", "relations"]
const root = fileURLToPath(new URL("./parity/", import.meta.url))
const update = process.env.PARITY_UPDATE === "1"

const server = await createServer({
  configFile: false,
  logLevel: "warn",
  plugins: [vue()],
  root,
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await server.close()
})
const base = server.resolvedUrls.local[0]

async function open(query = "") {
  const context = await browser.newContext({ viewport: { height: 600, width: 800 } })
  const page = await context.newPage()
  page.on("pageerror", error => console.log("[page error]", error.message))
  await page.goto(`${base}${query}`)
  await page.waitForFunction(() => window.parity && (!new URLSearchParams(location.search).has("engine") || window.parity.ready))
  return page
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))))
}

// The first line of an ARIA snapshot names the element itself, such as `tab "Files" [selected]`.
async function focused(page) {
  if (await page.evaluate(() => !document.activeElement || document.activeElement === document.body)) return "(body)"
  const snapshot = await page.locator(":focus").ariaSnapshot()
  return snapshot.split("\n")[0].replace(/^- /, "").replace(/:$/, "") || "(no role)"
}

function readRegions() {
  // Each text node is a word group of its own, as a screen reader reads it.
  const text = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const parts = []
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue.replace(/\s+/g, " ").trim())
    return parts.filter(Boolean).join(" ")
  }
  const describe = element => `${element.getAttribute("role") ?? element.localName} "${element.getAttribute("aria-label") ?? text(element).slice(0, 40)}"`
  const visible = [...document.body.querySelectorAll("*")].filter(element => element.checkVisibility())
  const live = [...document.querySelectorAll("[aria-live], [role=status], [role=alert], [role=log]")].map(element => ({
    role: element.getAttribute("role") ?? element.localName,
    live: element.getAttribute("aria-live"),
    atomic: element.getAttribute("aria-atomic"),
    text: text(element),
  }))
  const relations = visible.flatMap(element => ["aria-controls", "aria-labelledby", "aria-describedby"]
    .filter(attribute => element.hasAttribute(attribute))
    .map((attribute) => {
      const targets = element.getAttribute(attribute).split(/\s+/).map(id => document.getElementById(id))
      return `${describe(element)} ${attribute} ${targets.map(target => target ? describe(target) : "(missing)").join(", ")}`
    }))
  return { live, relations }
}

async function record(page, step) {
  await settle(page)
  const tree = (await page.locator("body").ariaSnapshot()).split("\n")
  return { step, focus: await focused(page), tree, ...await page.evaluate(readRegions) }
}

async function run(engine, component, steps) {
  const page = await open(`?engine=${engine}&component=${component}`)
  const records = [await record(page, "load")]
  for (const { name, run } of steps) {
    await run(page)
    records.push(await record(page, name))
  }
  await page.context().close()
  return { component, engine, steps: records }
}

const scripts = Object.fromEntries(await Promise.all(readdirSync(new URL("./parity/scripts/", import.meta.url))
  .map(async file => [file.replace(/\.mjs$/, ""), (await import(`./parity/scripts/${file}`)).default])))
const index = await open()
const engines = await index.evaluate(() => window.parity.engines)
await index.context().close()
const allowed = JSON.parse(readFileSync(new URL("./parity/allowed-differences.json", import.meta.url), "utf8"))
const snapshots = new Map()

for (const [engine, components] of Object.entries(engines)) {
  test(`${engine} has one fixture per script`, () => {
    assert.deepEqual(components, Object.keys(scripts).sort())
  })
  for (const component of components.filter(name => scripts[name])) {
    const names = scripts[component].map(step => step.name)
    assert.equal(new Set(names).size, names.length, `${component} has two steps with the same name`)
    test(`${component} on ${engine} matches its snapshot`, async () => {
      const actual = await run(engine, component, scripts[component])
      snapshots.set(`${component}.${engine}`, actual)
      const file = new URL(`./parity/snapshots/${component}.${engine}.json`, import.meta.url)
      if (update) writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
      else {
        assert.ok(existsSync(file), `${component} has no ${engine} snapshot. Run with PARITY_UPDATE=1 to record it.`)
        assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")))
      }
    })
  }
}

for (const engine of Object.keys(engines).filter(name => name !== reference)) {
  for (const component of Object.keys(scripts)) {
    test(`${component} on ${engine} behaves like ${reference}`, () => {
      const expected = snapshots.get(`${component}.${reference}`)
      const actual = snapshots.get(`${component}.${engine}`)
      assert.ok(expected && actual, `${component} did not run on both engines`)
      const accepted = allowed.filter(entry => entry.component === component && entry.engine === engine)
      const same = (entry, difference) => entry.step === difference.step && entry.field === difference.field
      const differences = expected.steps.flatMap((step, position) => fields
        .filter(field => !isDeepStrictEqual(step[field], actual.steps[position]?.[field]))
        .map(field => ({ field, step: step.step, [reference]: step[field], [engine]: actual.steps[position]?.[field] ?? null })))
      const unexpected = differences.filter(difference => !accepted.some(entry => same(entry, difference)))
      const stale = accepted.filter(entry => !differences.some(difference => same(entry, difference)))
      const show = value => JSON.stringify(value, null, 2)
      assert.ok(!unexpected.length, `${engine} differs from ${reference}. Fix the engine, or add each difference to allowed-differences.json with a reason:\n${show(unexpected)}`)
      assert.ok(!stale.length, `These allowed differences no longer happen. Remove them:\n${show(stale)}`)
    })
  }
}
