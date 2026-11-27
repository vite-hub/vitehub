// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeBrowser, createFakeDisk } from "../../device/test/support.ts"
import { operationRpcFetch, operationRpcRequest } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleAccount } from "../src/console/runtime/client/account.ts"

// One browser for each test: a disk that outlives the pages of the test, and the real device of `@vite-hub/device` on it.
const browser = { disk: createFakeDisk(), tabs: createFakeBrowser() }
vi.mock("../../device/src/indexeddb.ts", () => ({
  openIndexedDB: () => browser.disk.open(),
  browserChannel: () => browser.tabs.channel(),
}))
const signOut = vi.fn(async (): Promise<{ error: { message: string, status: number } | null }> => ({ error: null }))
vi.mock("better-auth/client", () => ({ createAuthClient: () => ({ signOut }) }))
vi.mock("better-auth/client/plugins", () => ({ organizationClient: () => ({}) }))
vi.mock("@better-auth/passkey/client", () => ({ passkeyClient: () => ({}) }))

const linked = { id: "p-1", url: "https://app.example.com", label: "Docs", publicKey: "a".repeat(43), keyVariable: "VITEHUB_CONSOLE_KEY_CONSOLE_P1" }
const ada: ConsoleAccount = { user: { id: "u-ada", name: "Ada", email: "ada@example.com", image: null }, hasEmail: true, teams: [{ id: "t-1", name: "Personal", slug: "personal" }], teamId: "t-1", roles: ["owner"], projects: [linked] }
const bob: ConsoleAccount = { ...ada, user: { id: "u-bob", name: "Bob", email: "bob@example.com", image: null } }

afterEach(() => {
  browser.disk = createFakeDisk()
  browser.tabs = createFakeBrowser()
  vi.unstubAllGlobals()
})

/** The Console server and the app behind it. A test changes the answers between page loads. */
function server() {
  // `holdAccount` holds only `/api/account`. `navigation: false` answers project.get without its navigation.
  const answers = { account: ada as ConsoleAccount | undefined, sections: ["kv", "logs"], projectStatus: 200, hold: false, holdAccount: false, navigation: true }
  const sent: string[] = []
  const held: (() => void)[] = []
  const fetch = vi.fn(operationRpcFetch(async (url: string, init: RequestInit) => {
    const call = url === "/api/account" ? "account" : `${operationRpcRequest(init.body).operation} ${url}`
    sent.push(call)
    // The session of the cookie that the request carried: a held request answers as it was sent.
    const account = answers.account
    if (answers.hold || (answers.holdAccount && call === "account")) await new Promise<void>(resolve => held.push(resolve))
    // A loader call that the device started over is aborted, as `fetch()` rejects then.
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
    if (call === "account") return account ? Response.json(account) : Response.json({ code: "UNAUTHORIZED", message: "Sign in." }, { status: 401 })
    if (answers.projectStatus !== 200) return Response.json({ code: "CONSOLE_ACCESS_DENIED", message: "No access to this app.", ok: false, status: answers.projectStatus }, { status: answers.projectStatus })
    return Response.json({ ok: true, value: { protocol: 1, name: "Shop", operations: [], sections: answers.sections, ...(answers.navigation ? { navigation: { sections: answers.sections } } : {}) } })
  }))
  return {
    answers,
    fetch,
    sent,
    /** Lets the held requests answer. */
    release: () => {
      answers.hold = false
      answers.holdAccount = false
      for (const resolve of held.splice(0)) resolve()
    },
  }
}

/** A page load of the Console on `/`, with a session cookie: fresh modules on the same disk. */
async function openPage(app: ReturnType<typeof server>) {
  vi.resetModules()
  // Each page has its own device. `vi.doMock()` runs the factory again, where `vi.mock()` would keep the first device.
  vi.doMock("@vite-hub/device", () => import("../../device/src/index.ts"))
  vi.doMock("@vite-hub/device/vue", () => import("../../device/src/vue.ts"))
  // The tab of the last page is gone.
  browser.tabs = createFakeBrowser()
  vi.stubGlobal("fetch", app.fetch)
  const session = await import("../src/console/runtime/client/project-session.ts")
  const sections = await import("../src/console/runtime/client/sections.ts")
  const device = await import("../../device/src/index.ts")
  const navigate = vi.fn()
  const start = () => session.startConsoleAccount({ boot: "app", home: "/", navigate, pageOrigin: "https://console.example.com", pathname: "/", search: "", showPath: () => {} })
  return { session, sections, device, navigate, start }
}

/** Whether `promise` settled `ms` milliseconds later. */
function settles<T>(promise: Promise<T>) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  return { promise, after: (ms: number) => new Promise<boolean>(resolve => setTimeout(() => resolve(settled), ms)) }
}

/** The first visit: the account and the app answer, and the device keeps both. */
async function firstVisit(app: ReturnType<typeof server>) {
  const page = await openPage(app)
  await page.start()
  await page.session.openConsoleProject()
  expect(page.session.useConsoleProjects().gate.value).toEqual({ kind: "ready" })
  await vi.waitFor(() => expect(browser.disk.keys).toEqual(["console:account", "console:project:p-1"]))
  expect(browser.disk.meta).toMatchObject({ account: "u-ada", version: "console-1" })
  return page
}

describe("account Console with stored reads", () => {
  it("opens a warm visit from the stored account and project.get, before either answers, then refreshes them", async () => {
    const app = server()
    await firstVisit(app)
    app.sent.length = 0
    app.answers.hold = true
    const page = await openPage(app)
    await page.start()
    const projects = page.session.useConsoleProjects()
    expect(projects.account.value).toEqual(ada)
    // The app opens in the same task: the page never shows its loading state.
    void page.session.openConsoleProject()
    expect(projects.gate.value).toEqual({ kind: "ready" })
    expect(projects.info.value?.name).toBe("Shop")
    expect((await page.sections.loadConsoleNavigation(page.sections.consoleSectionsPath))?.sections).toEqual(["kv", "mcp-client", "logs"])
    await page.session.consoleProjectReady()
    // The account read went out. project.get waits for it to name the account, so it goes out once.
    expect(app.sent).toEqual(["account"])
    app.release()
    await vi.waitFor(() => expect(page.device.inspectDevice()).toMatchObject({ account: "u-ada", persisted: true }))
    await vi.waitFor(() => expect(app.sent).toEqual(["account", "project.get /p/p-1/_vitehub/rpc"]))
    app.release()
    expect(page.navigate).not.toHaveBeenCalled()
    expect(projects.gate.value).toEqual({ kind: "ready" })
  })

  it("drops a section that the access lost when the answer of the visit arrives", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.sections = ["logs"]
    const page = await openPage(app)
    await page.start()
    void page.session.openConsoleProject()
    const shown: string[][] = []
    page.sections.subscribeConsoleNavigation(page.sections.consoleSectionsPath, navigation => shown.push(navigation.sections))
    expect(shown).toEqual([["kv", "mcp-client", "logs"]])
    app.release()
    await vi.waitFor(() => expect(shown).toEqual([["kv", "mcp-client", "logs"], ["mcp-client", "logs"]]))
    const navigation = await page.sections.loadConsoleNavigation(page.sections.consoleSectionsPath)
    expect(navigation?.sections).toEqual(["mcp-client", "logs"])
    // A page of the lost section goes to the Overview (`main.js`), and the next visit opens without it.
    expect(page.sections.isConsoleSectionRevoked("kv", navigation!)).toBe(true)
    expect(page.sections.isConsoleSectionRevoked("logs", navigation!)).toBe(false)
    await vi.waitFor(() => expect(JSON.parse(browser.disk.entry("console:project:p-1")!.json).info.navigation.sections).toEqual(["logs"]))
  })

  it.each([401, 403])("closes the app when project.get answers %s, and the next visit waits for the app", async (status) => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.projectStatus = status
    const page = await openPage(app)
    await page.start()
    const opening = page.session.openConsoleProject()
    const projects = page.session.useConsoleProjects()
    expect(projects.gate.value).toEqual({ kind: "ready" })
    app.release()
    await opening
    expect(projects.gate.value.kind).toBe(status === 401 ? "setup" : "problem")
    // The refusal replaced the stored answer, so the next visit does not open from it.
    await vi.waitFor(() => expect(JSON.parse(browser.disk.entry("console:project:p-1")!.json).kind).not.toBe("ready"))
    app.answers.hold = true
    const next = await openPage(app)
    await next.start()
    void next.session.openConsoleProject()
    expect(next.session.useConsoleProjects().gate.value).toEqual({ kind: "opening" })
  })

  it("loads the page again without the stored answers when another person signed in", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.account = bob
    // Each copy that reaches the disk, with the account of the disk that the write expects.
    const written: string[] = []
    const open = browser.disk.open
    browser.disk.open = async () => {
      const storage = await open()
      return { ...storage, write: (expected, change) => {
        written.push(...change.puts.map(entry => `${expected.account} ${entry.json}`))
        return storage.write(expected, change)
      } }
    }
    const page = await openPage(app)
    await page.start()
    app.release()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    // The answer for Bob never reached the disk as a copy of Ada, also not for a moment, as when the tab closes then.
    expect(written.filter(copy => copy.startsWith("u-ada ") && copy.includes("u-bob"))).toEqual([])
    // Nothing of Ada stays on the device, and the device belongs to Bob now.
    expect(browser.disk.keys).toEqual([])
    expect(browser.disk.meta?.account).toBe("u-bob")
    // The next page waits for the account of Bob.
    app.answers.hold = true
    const next = await openPage(app)
    const starting = settles(next.start())
    await vi.waitFor(() => expect(app.sent.at(-1)).toBe("account"))
    expect(await starting.after(20)).toBe(false)
    app.release()
    await starting.promise
    expect(next.session.useConsoleProjects().account.value).toEqual(bob)
  })

  it("loads the page again when the session ended, and forgets the account", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.account = undefined
    const page = await openPage(app)
    await page.start()
    app.release()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(browser.disk.keys).toEqual([])
    expect(browser.disk.meta?.account).toBeNull()
  })

  it("loads the page again when the team unlinked the open app", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.account = { ...ada, projects: [{ ...linked, id: "p-2", url: "https://other.example.com" }] }
    const page = await openPage(app)
    await page.start()
    expect(page.session.useConsoleProjects().current.value?.id).toBe("p-1")
    app.release()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(browser.disk.keys).toEqual([])
  })

  it("shows a new name or role of the same account in place", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.account = { ...ada, roles: ["member"], projects: [{ ...linked, label: "Docs site" }] }
    const page = await openPage(app)
    await page.start()
    void page.session.openConsoleProject()
    app.release()
    const projects = page.session.useConsoleProjects()
    await vi.waitFor(() => expect(projects.account.value?.roles).toEqual(["member"]))
    expect(projects.projects.value).toEqual([{ id: "p-1", url: "https://app.example.com", label: "Docs site" }])
    expect(page.navigate).not.toHaveBeenCalled()
  })

  it("deletes the stored answers on sign-out, in every tab", async () => {
    const app = server()
    const page = await firstVisit(app)
    // The server ends the session at once, so a read that started over would answer 401 fast.
    signOut.mockImplementationOnce(async () => {
      app.answers.account = undefined
      return { error: null }
    })
    await page.session.signOutConsole()
    expect(signOut).toHaveBeenCalled()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(browser.disk.keys).toEqual([])
    expect(browser.disk.meta?.account).toBeNull()
    // The menu loads the Console once.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(page.navigate).toHaveBeenCalledTimes(1)
  })

  it("deletes the stored answers before a team switch or a new app loads the page again", async () => {
    const app = server()
    const page = await firstVisit(app)
    page.session.reloadConsoleAccount()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(browser.disk.keys).toEqual([])
    // The device still belongs to Ada, so the next answers are kept again.
    expect(browser.disk.meta?.account).toBe("u-ada")
  })

  it("never stores an app answer under the stored account before /api/account confirms who is signed in", async () => {
    const app = server()
    await firstVisit(app)
    app.sent.length = 0
    // Bob signed in on this computer. The account answer waits.
    app.answers.account = bob
    app.answers.sections = ["logs"]
    app.answers.holdAccount = true
    const written: string[] = []
    const open = browser.disk.open
    browser.disk.open = async () => {
      const storage = await open()
      return { ...storage, write: (expected, change) => {
        written.push(...change.puts.map(entry => `${expected.account} ${entry.key} ${entry.json}`))
        return storage.write(expected, change)
      } }
    }
    const page = await openPage(app)
    await page.start()
    void page.session.openConsoleProject()
    await new Promise(resolve => setTimeout(resolve, 20))
    // The tab can close now: nothing that Bob's cookie answered is on the disk as a copy of Ada. The app read waits for
    // the account read, so it has not gone out.
    expect(written).toEqual([])
    expect(app.sent).toEqual(["account"])
    app.release()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(written.filter(copy => copy.startsWith("u-ada "))).toEqual([])
    expect(browser.disk.meta?.account).toBe("u-bob")
  })

  it("loads the page again when another tab signs out while the account answers, after the read starts over", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.holdAccount = true
    const page = await openPage(app)
    await page.start()
    void page.session.openConsoleProject()
    // Another tab of this browser signs out: the server ends the session, and its device names nobody.
    app.answers.account = undefined
    const { createDevice } = await import("../../device/src/device.ts")
    const other = createDevice({ openStorage: () => browser.disk.open(), channel: browser.tabs.channel() })
    await other.open({ version: "console-1" })
    await other.setAccount(null)
    app.release()
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(browser.disk.meta?.account).toBeNull()
    expect(browser.disk.keys).toEqual([])
  })

  it("opens the app of a ?app= link on a first visit, also when the naming starts its project.get over", async () => {
    const app = server()
    const page = await openPage(app)
    const address = await page.session.startConsoleAccount({ boot: "app", home: "/", navigate: page.navigate, pageOrigin: "https://console.example.com", pathname: "/", search: "?app=p-1", showPath: () => {} })
    expect(address).toBeUndefined()
    await page.session.openConsoleProject()
    expect(page.session.useConsoleProjects().gate.value).toEqual({ kind: "ready" })
    await vi.waitFor(() => expect(browser.disk.keys).toEqual(["console:account", "console:project:p-1"]))
  })

  it("loads the sections again when project.get of this visit has no navigation", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    app.answers.navigation = false
    app.answers.sections = ["logs"]
    const page = await openPage(app)
    await page.start()
    void page.session.openConsoleProject()
    expect((await page.sections.loadConsoleNavigation(page.sections.consoleSectionsPath))?.sections).toEqual(["kv", "mcp-client", "logs"])
    app.release()
    await vi.waitFor(async () => expect((await page.sections.loadConsoleNavigation(page.sections.consoleSectionsPath))?.sections).toEqual(["mcp-client", "logs"]))
    expect(app.sent).toContain("sections.list /p/p-1/_vitehub/rpc")
  })

  it("applies a later project.get answer, such as a 403 after another tab cleared the device", async () => {
    const app = server()
    const page = await firstVisit(app)
    const projects = page.session.useConsoleProjects()
    app.answers.projectStatus = 403
    const { createDevice } = await import("../../device/src/device.ts")
    const other = createDevice({ openStorage: () => browser.disk.open(), channel: browser.tabs.channel() })
    await other.open({ version: "console-1" })
    await other.clear()
    await vi.waitFor(() => expect(projects.gate.value.kind).toBe("problem"))
  })

  it("asks project.get again when the person retries an app that refused", async () => {
    const app = server()
    app.answers.projectStatus = 403
    const page = await openPage(app)
    await page.start()
    await page.session.openConsoleProject()
    const projects = page.session.useConsoleProjects()
    expect(projects.gate.value.kind).toBe("problem")
    const asked = app.sent.filter(call => call.startsWith("project.get")).length
    app.answers.projectStatus = 200
    await page.session.openConsoleProject()
    expect(app.sent.filter(call => call.startsWith("project.get")).length).toBe(asked + 1)
    expect(projects.gate.value).toEqual({ kind: "ready" })
  })

  it("loads a signed-out page again when another tab signs in", async () => {
    const app = server()
    app.answers.account = undefined
    const page = await openPage(app)
    await page.session.startConsoleAccount({ boot: "sign-in", home: "/", navigate: page.navigate, pageOrigin: "https://console.example.com", pathname: "/", search: "", showPath: () => {} })
    expect(page.session.useConsoleProjects().gate.value.kind).toBe("account")
    // Another tab of this browser signs in as Ada.
    app.answers.account = ada
    const { createDevice } = await import("../../device/src/device.ts")
    const other = createDevice({ openStorage: () => browser.disk.open(), channel: browser.tabs.channel() })
    await other.open({ version: "console-1" })
    await other.setAccount("u-ada")
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
    expect(page.navigate).toHaveBeenCalledTimes(1)
  })

  it("keeps following the account after a failed sign-out", async () => {
    const app = server()
    const page = await firstVisit(app)
    signOut.mockImplementationOnce(async () => ({ error: { message: "Sign out failed.", status: 500 } }))
    await expect(page.session.signOutConsole()).rejects.toThrow()
    // Another tab signs out.
    app.answers.account = undefined
    const { createDevice } = await import("../../device/src/device.ts")
    const other = createDevice({ openStorage: () => browser.disk.open(), channel: browser.tabs.channel() })
    await other.open({ version: "console-1" })
    await other.setAccount(null)
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledWith("/"))
  })

  it("does not open the stored app again on a retry after a refusal of this visit", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.projectStatus = 403
    const page = await openPage(app)
    await page.start()
    await page.session.openConsoleProject()
    const projects = page.session.useConsoleProjects()
    expect(projects.gate.value.kind).toBe("problem")
    app.answers.hold = true
    void page.session.openConsoleProject()
    expect(projects.gate.value).toEqual({ kind: "opening" })
    app.answers.projectStatus = 200
    app.release()
    await vi.waitFor(() => expect(projects.gate.value).toEqual({ kind: "ready" }))
  })

  it("keeps an account page that the person opened when a later project.get answers", async () => {
    const app = server()
    app.answers.projectStatus = 403
    const page = await openPage(app)
    await page.start()
    await page.session.openConsoleProject()
    const projects = page.session.useConsoleProjects()
    expect(projects.gate.value.kind).toBe("problem")
    page.session.showConsoleAccountPage("settings")
    expect(projects.gate.value).toEqual({ kind: "home", page: "settings" })
    app.answers.projectStatus = 200
    const { createDevice } = await import("../../device/src/device.ts")
    const other = createDevice({ openStorage: () => browser.disk.open(), channel: browser.tabs.channel() })
    await other.open({ version: "console-1" })
    await other.clear()
    await vi.waitFor(() => expect(app.sent.filter(call => call.startsWith("project.get")).length).toBeGreaterThan(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(projects.gate.value).toEqual({ kind: "home", page: "settings" })
  })

  it("applies the answer of a retry once", async () => {
    const app = server()
    app.answers.navigation = false
    const page = await openPage(app)
    await page.start()
    await page.session.openConsoleProject()
    await page.sections.loadConsoleNavigation(page.sections.consoleSectionsPath)
    app.answers.projectStatus = 403
    await page.session.openConsoleProject()
    app.answers.projectStatus = 200
    const lists = app.sent.filter(call => call.startsWith("sections.list")).length
    await page.session.openConsoleProject()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(app.sent.filter(call => call.startsWith("sections.list")).length).toBe(lists + 1)
  })

  it("waits for the account on a page without a session cookie, and for a link to an app that the stored account lacks", async () => {
    const app = server()
    await firstVisit(app)
    app.answers.hold = true
    const signIn = await openPage(app)
    const starting = settles(signIn.session.startConsoleAccount({ boot: "sign-in", home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/", search: "", showPath: () => {} }))
    await vi.waitFor(() => expect(app.sent.at(-1)).toBe("account"))
    expect(await starting.after(20)).toBe(false)
    app.release()
    await starting.promise

    app.answers.hold = true
    app.answers.account = { ...ada, projects: [linked, { ...linked, id: "p-2", url: "https://new.example.com" }] }
    const link = await openPage(app)
    const opening = link.session.startConsoleAccount({ boot: "app", home: "/", navigate: vi.fn(), pageOrigin: "https://console.example.com", pathname: "/", search: "?app=p-2", showPath: () => {} })
    // project.get of the linked app goes out with the account.
    await vi.waitFor(() => expect(app.sent.slice(-2)).toEqual(["account", "project.get /p/p-2/_vitehub/rpc"]))
    app.release()
    await opening
    expect(link.session.useConsoleProjects().current.value?.id).toBe("p-2")
  })
})
