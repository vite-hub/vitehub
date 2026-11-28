import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

const kit = fileURLToPath(new URL("../", import.meta.url))
const published = resolve(kit, "../../docs/public/r")
const fixture = fileURLToPath(new URL("./registry-install/", import.meta.url))
const app = resolve(process.env.REGISTRY_APP_DIR ?? join(kit, "node_modules/.cache/registry-install-app"))
const registryPort = Number(process.env.REGISTRY_PORT ?? 4841)
const appPort = Number(process.env.REGISTRY_APP_PORT ?? 4842)
const screenshots = process.env.REGISTRY_SCREENSHOTS && resolve(process.env.REGISTRY_SCREENSHOTS)

const index = JSON.parse(readFileSync(join(published, "registry.json"), "utf8"))
const componentItems = index.items.filter(item => ["registry:lib", "registry:theme", "registry:ui", "registry:block"].includes(item.type))

function run(command, args) {
  const child = spawn(command, args, { cwd: app, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NUXT_TELEMETRY_DISABLED: "1", CI: "1" } })
  return new Promise((done, fail) => {
    child.on("error", fail)
    child.on("exit", code => (code === 0 ? done() : fail(new Error(`${command} ${args.join(" ")} exited with ${code}`))))
  })
}

let registry
before(async () => {
  registry = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.replace(/^\/r\//, ""))
    const file = join(published, name)
    if (!/^[a-z0-9-]+\.json$/.test(name) || !existsSync(file)) return response.writeHead(404).end()
    response.writeHead(200, { "content-type": "application/json" }).end(readFileSync(file))
  })
  await new Promise((done, fail) => {
    registry.once("error", fail)
    registry.listen(registryPort, "127.0.0.1", done)
  })
})
after(() => registry?.close())

test("every registry item installs into a new Nuxt 4.7 app that builds without Nuxt UI or Reka UI", async () => {
  rmSync(app, { force: true, recursive: true })
  mkdirSync(app, { recursive: true })
  cpSync(fixture, app, { recursive: true, filter: source => !source.endsWith("app.vue") && !source.includes("/app/components") })
  const components = readFileSync(join(app, "components.json"), "utf8").replace("{registry}", `http://127.0.0.1:${registryPort}/r`)
  writeFileSync(join(app, "components.json"), components)
  writeFileSync(join(app, "pnpm-workspace.yaml"), "packages: []\nallowBuilds:\n  esbuild: true\n  \"@tailwindcss/oxide\": true\n  \"@parcel/watcher\": false\n  unrs-resolver: false\n")
  writeFileSync(join(app, "package.json"), `${JSON.stringify({
    name: "registry-install-app",
    private: true,
    type: "module",
    dependencies: { "@tailwindcss/vite": "4.3.5", nitro: "3.0.261103-rc", nuxt: "4.7.0", tailwindcss: "4.3.5", vue: "^3.5.0" },
    devDependencies: { typescript: "^6.0.3", "vue-tsc": "^3.3.14" },
  }, null, 2)}\n`)

  await run("pnpm", ["install", "--prefer-offline"])
  await run("pnpm", ["exec", "nuxi", "prepare"])
  await run("pnpm", ["dlx", "shadcn-vue@2.9.0", "add", ...componentItems.map(item => `@vitehub/${item.name}`), "--yes", "--overwrite"])

  for (const item of componentItems) {
    const built = JSON.parse(readFileSync(join(published, `${item.name}.json`), "utf8"))
    for (const file of built.files ?? []) {
      const target = file.target || (file.type === "registry:lib" ? `app/lib/${file.path.split("/").pop()}` : file.type === "registry:component" ? `app/components/${file.path.split("/").slice(1).join("/")}` : `app/components/${file.path}`)
      assert.ok(existsSync(join(app, target)), `${item.name}: ${target} is missing`)
    }
  }
  const css = readFileSync(join(app, "app/assets/css/main.css"), "utf8")
  assert.match(css, /^@layer ui-sdk;\n@import "tailwindcss";/, "the ui-sdk layer must stay first")
  assert.equal(css.match(/@layer ui-sdk;/g)?.length, 1, "shadcn-vue must not add a second ui-sdk layer")

  const installed = JSON.parse(readFileSync(join(app, "package.json"), "utf8"))
  const dependencies = componentItems.flatMap(item => item.dependencies ?? [])
  for (const name of ["@ui-sdk/vue", "@ui-sdk/core"]) {
    const pin = dependencies.find(dependency => dependency.startsWith(`${name}@`))
    assert.ok(pin, `${name} must have a registry pin`)
    assert.equal(installed.dependencies[name], pin.slice(name.length + 1))
  }

  cpSync(join(fixture, "app/app.vue"), join(app, "app/app.vue"))
  cpSync(join(fixture, "app/components"), join(app, "app/components"), { recursive: true })
  await run("pnpm", ["exec", "nuxi", "typecheck"])
  await run("pnpm", ["exec", "nuxt", "build"])

  const deps = Object.keys({ ...installed.dependencies, ...installed.devDependencies })
  assert.deepEqual(deps.filter(name => name === "reka-ui" || name === "@nuxt/ui"), [])
  const store = readdirSync(join(app, "node_modules/.pnpm"))
  assert.ok(store.some(name => name.startsWith("nitro@3.")), "the fixture must install Nitro 3")
  assert.deepEqual(store.filter(name => /^(?:reka-ui|@nuxt\+ui)@/.test(name)), [])
  const output = spawnSync("grep", ["-rlE", "reka-ui|@nuxt/ui", ".output"], { cwd: app, encoding: "utf8" })
  assert.equal(output.stdout.trim(), "", "the build output names Reka UI or Nuxt UI")
  assert.equal(output.status, 1)
})

test("the demo page renders every item in light and dark, at 390px and 1280px", { skip: !screenshots }, async () => {
  assert.ok(existsSync(join(app, ".output/server/index.mjs")), "the app did not build")
  const { chromium } = await import("playwright-core")
  mkdirSync(screenshots, { recursive: true })
  const server = spawn(process.execPath, [".output/server/index.mjs"], { cwd: app, env: { ...process.env, PORT: String(appPort), HOST: "127.0.0.1" }, stdio: "inherit" })
  const browser = await chromium.launch()
  try {
    await waitFor(`http://127.0.0.1:${appPort}/`)
    const errors = []
    for (const theme of ["light", "dark"]) {
      for (const width of [390, 1280]) {
        const context = await browser.newContext({ colorScheme: theme, viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768 })
        const page = await context.newPage()
        page.on("pageerror", error => errors.push(`${theme} ${width}: ${error.message}`))
        page.on("console", message => message.type() === "error" && errors.push(`${theme} ${width}: ${message.text()}`))
        const closed = () => page.waitForFunction(() => !document.querySelector("[inert], [role=dialog], [role=menu]"))
        const shot = async name => {
          await page.waitForTimeout(450)
          await page.screenshot({ path: join(screenshots, `${name}-${theme}-${width}.png`) })
        }
        await page.goto(`http://127.0.0.1:${appPort}/?theme=${theme}`)
        await page.waitForSelector("[data-demo-section=overlays]")
        await page.evaluate(() => document.fonts.ready)
        await shot("page")
        await page.screenshot({ path: join(screenshots, `page-full-${theme}-${width}.png`), fullPage: true })

        await page.keyboard.press("Tab")
        await shot("focus")
        const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle)
        assert.notEqual(ring, "none", `${theme} ${width}: the first Tab stop has no focus ring`)

        await page.locator("[data-slot=sidebar-trigger]").click()
        await shot("sidebar-toggled")
        const documents = page.getByRole("button", { name: "Documents" })
        const drafts = page.getByRole("link", { name: "Drafts" })
        if (width < 768) {
          const inbox = page.getByRole("link", { name: "Inbox" })
          await inbox.click({ modifiers: ["ControlOrMeta"] })
          assert.ok(await inbox.isVisible(), "a modified click must leave the drawer open")
          await inbox.click()
          await page.waitForURL(url => url.hash === "#inbox")
          await closed()

          await page.locator("[data-slot=sidebar-trigger]").click()
          await documents.click()
          await drafts.press("Enter")
          await page.waitForURL(url => url.hash === "#drafts")
          await closed()
        } else {
          await documents.click()
          await drafts.waitFor({ state: "visible" })
          await page.locator("[data-slot=sidebar-trigger]").click()
          await documents.click()
          await drafts.waitFor({ state: "visible" })
        }

        await page.locator("#notes").focus()
        await page.keyboard.press("Tab")
        await page.waitForFunction(() => document.activeElement?.id === "status" && getComputedStyle(document.activeElement).outlineStyle === "solid")

        for (const name of ["dialog", "sheet", "menu", "command"]) {
          const trigger = page.locator(`[data-demo=${name}]`)
          if (name === "command") {
            await trigger.press("Enter")
            await page.waitForFunction(() => document.activeElement?.matches("[placeholder='Type a command or search']") && getComputedStyle(document.activeElement).outlineStyle === "solid")
            await page.keyboard.type("se")
          } else await trigger.click()
          await shot(name)
          if (name === "sheet") {
            const apply = page.getByRole("button", { name: "Apply" })
            await apply.evaluate(button => {
              const filler = document.createElement("div")
              filler.style.flex = "0 0 1200px"
              button.parentElement.before(filler)
            })
            const sheet = page.getByRole("dialog", { name: "Filters" })
            assert.ok(await sheet.evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === "auto"), "long sheet content must scroll")
            await apply.click()
            await closed()
            continue
          }
          await page.keyboard.press("Escape")
          if (name === "command") await page.keyboard.press("Escape")
          await closed()
        }

        await page.getByRole("tab", { name: "Open" }).click()
        await page.locator("[data-demo-section=tabs]").scrollIntoViewIfNeeded()
        await shot("tabs")

        await page.locator("[data-demo=toast]").click()
        await page.waitForFunction(() => document.querySelector("[data-slot=toast]")?.getAnimations().length === 0)
        await shot("toast")
        const toast = await page.locator("[data-slot=toast]").boundingBox()
        assert.ok(toast && toast.x >= 8 && toast.x + toast.width <= width - 8 && toast.y + toast.height <= 900 - 8, `${theme} ${width}: the toast touches the viewport edge`)

        await page.getByRole("button", { name: "Dismiss" }).click()
        await page.locator("[data-slot=toast]").waitFor({ state: "hidden" })

        const chat = page.locator("[data-demo-section=chat]")
        await chat.scrollIntoViewIfNeeded()
        await chat.getByRole("button", { name: /publishPreview.*Decision received/ }).waitFor()
        assert.equal(await chat.getByRole("button", { name: /updateDomain/ }).getAttribute("aria-expanded"), "true")
        assert.equal(await chat.getByRole("button", { name: /updateProject/ }).getAttribute("aria-expanded"), "false")
        await page.waitForTimeout(450)
        await chat.screenshot({ path: join(screenshots, `chat-${theme}-${width}.png`) })

        await chat.locator("[data-tool-state]", { hasText: "readProject" }).getByRole("button", { name: /readProject/ }).click()
        await page.waitForTimeout(450)
        await chat.screenshot({ path: join(screenshots, `tool-${theme}-${width}.png`) })

        const prompt = chat.getByRole("textbox", { name: "Message" })
        const send = chat.getByRole("button", { name: "Send", exact: true })
        const stop = chat.getByRole("button", { name: "Stop", exact: true })
        await prompt.fill("Ship acme-web tonight")
        const size = await prompt.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
        assert.ok(width >= 768 || size >= 16, `${theme} ${width}: the prompt text is ${size}px on touch`)
        await page.waitForTimeout(200)
        await chat.locator("[data-demo=prompt]").screenshot({ path: join(screenshots, `prompt-${theme}-${width}.png`) })
        assert.equal(await prompt.getAttribute("enterkeyhint"), width < 768 ? "enter" : "send")
        await prompt.dispatchEvent("keydown", { key: "Enter", isComposing: true })
        assert.equal(await prompt.inputValue(), "Ship acme-web tonight", "IME Enter must not submit")
        await prompt.press("End")
        if (width < 768) {
          await prompt.press("Enter")
          assert.equal(await prompt.inputValue(), "Ship acme-web tonight\n", "touch Enter must add a line")
          await send.click()
        } else {
          await prompt.press("Shift+Enter")
          assert.equal(await prompt.inputValue(), "Ship acme-web tonight\n", "Shift+Enter must add a line")
          await prompt.press("Enter")
        }
        const sent = chat.locator("[data-slot=message][data-from=user]", { hasText: "Ship acme-web tonight" })
        await sent.waitFor()
        assert.equal(await prompt.inputValue(), "", `${theme} ${width}: sending did not clear the prompt`)
        await stop.waitFor()
        await page.waitForTimeout(450)
        const log = await chat.locator("[data-slot=message-list]").boundingBox()
        const bubble = await sent.boundingBox()
        assert.ok(log && bubble && bubble.y >= log.y && bubble.y + bubble.height <= log.y + log.height, `${theme} ${width}: the sent message is out of view`)
        await chat.screenshot({ path: join(screenshots, `chat-sent-${theme}-${width}.png`) })
        await prompt.fill("Follow-up draft")
        await prompt.press("End")
        await prompt.press("Enter")
        assert.equal(await prompt.inputValue(), "Follow-up draft\n", "pending Enter must add a line")
        await stop.click()
        await send.waitFor()
        assert.equal(await prompt.inputValue(), "Follow-up draft\n", "Stop must keep the draft")
        await context.close()
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    server.kill()
  }
})

async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`${url} did not start`)
}
