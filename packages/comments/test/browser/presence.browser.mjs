// Mounts the comments overlay from its sources in headless Chromium with a Realtime room that the test fills, and
// checks the faces in the pill: each person shows once, and the signed-in person once, on the sign-out button.
// Run: pnpm --filter @vite-hub/comments test:browser
import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { createServer } from "vite"

import { overlayAliases, standaloneUI } from "../../overlay.aliases.ts"

const port = Number(process.env.COMMENTS_PRESENCE_BROWSER_PORT ?? 4798)
const image = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='#c08457'/></svg>")}`
const maxi = { id: "u1", name: "Maxi", image, color: "#fbbf24" }
const ada = { id: "u2", name: "Ada", color: "#60a5fa" }
// Maxi has the page open in two tabs, so the room has two clients for one person.
const maxiTabs = [{ ...maxi, clientId: 1 }, { ...maxi, clientId: 2 }]

/** The `/session` answer for Maxi, signed in with GitHub or with the site's own account. */
function session(github) {
  return {
    user: { id: maxi.id, name: maxi.name, image: maxi.image },
    ...(github ? { github: { login: "onmax", write: true }, signOut: "/api/_vitehub/comments/auth/sign-out" } : {}),
    can: { read: true, comment: true, resolve: true },
    realtime: true,
    content: false,
  }
}

test("each person shows once in the pill", { timeout: 120_000 }, async (t) => {
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    optimizeDeps: { noDiscovery: true },
    plugins: [standaloneUI()],
    resolve: {
      alias: [...overlayAliases, { find: /^@vite-hub\/realtime\/client$/, replacement: fileURLToPath(new URL("./realtime-stub.ts", import.meta.url)) }],
      dedupe: ["vue"],
    },
    root: fileURLToPath(new URL("./page", import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true },
  })
  await server.listen()
  t.after(() => server.close())
  const browser = await chromium.launch()
  t.after(() => browser.close())

  /** Opens the page as Maxi with these people in the room, and reads the faces in the pill. */
  async function faces({ github, room }) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } })
    try {
      await page.route("**/api/_vitehub/comments/**", route => route.fulfill({
        json: new URL(route.request().url()).pathname.endsWith("/session") ? { data: session(github), people: [] } : { data: [], people: [] },
      }))
      await page.goto(`http://127.0.0.1:${port}/`)
      await page.waitForFunction(() => window.vitehubTestRoomJoined, undefined, { timeout: 15_000 })
      await page.evaluate(people => window.vitehubTestPresence(people), room)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      return await page.evaluate(() => {
        const bar = document.querySelector("vitehub-tool").shadowRoot
        return {
          presence: [...bar.querySelectorAll(".people .avatar")].map(avatar => avatar.title),
          label: bar.querySelector(".people")?.getAttribute("aria-label") ?? null,
          account: bar.querySelectorAll("button[aria-label^='Sign out'] img.me").length,
        }
      })
    }
    finally {
      await page.close()
    }
  }

  await t.test("signed in with GitHub and alone, in two tabs: one face, on the sign-out button", async () => {
    assert.deepEqual(await faces({ github: true, room: maxiTabs }), { presence: [], label: null, account: 1 })
  })

  await t.test("signed in with GitHub, with Ada on the page: Ada once, and Maxi once on the sign-out button", async () => {
    assert.deepEqual(await faces({ github: true, room: [...maxiTabs, { ...ada, clientId: 3 }] }), { presence: ["Ada"], label: "1 other person on this page", account: 1 })
  })

  await t.test("signed in with the site's account, there is no sign-out button, so presence shows Maxi once", async () => {
    assert.deepEqual(await faces({ github: false, room: [...maxiTabs, { ...ada, clientId: 3 }] }), { presence: ["Maxi", "Ada"], label: "2 people on this page", account: 0 })
  })
})
