import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it, vi } from "vitest"

import { clearDevice, inspectDevice, openDevice, setDeviceAccount } from "../src/index.ts"
import { useStoredData, useStoredFetch } from "../src/vue.ts"

it("renders the default on the server, reads no storage, and calls no loader", async () => {
  const loader = vi.fn(async () => ["p1"])
  let status = ""
  const app = createSSRApp(defineComponent({
    setup() {
      const projects = useStoredData("projects", loader, { default: () => [] as string[] })
      status = projects.status.value
      return () => h("p", projects.data.value.length ? projects.data.value.join(",") : "No projects yet")
    },
  }))
  expect(await renderToString(app)).toBe("<p>No projects yet</p>")
  expect(status).toBe("idle")
  expect(loader).not.toHaveBeenCalled()
})

it("keeps no account and no copy in server memory", async () => {
  await openDevice()
  expect(await setDeviceAccount("ada")).toEqual([undefined, undefined])
  expect(await clearDevice()).toEqual([undefined, undefined])
  expect(inspectDevice()).toEqual({ account: null, persisted: false, storage: "memory", entries: [] })
})

it("renders the default of useStoredFetch() on the server and sends no request", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  try {
    const app = createSSRApp(defineComponent({
      setup() {
        const projects = useStoredFetch<string[]>("/api/projects", { query: { team: "t1" }, default: () => [] })
        return () => h("p", `${projects.data.value.length} ${projects.status.value}`)
      },
    }))
    expect(await renderToString(app)).toBe("<p>0 idle</p>")
    expect(fetch).not.toHaveBeenCalled()
  }
  finally {
    vi.unstubAllGlobals()
  }
})
