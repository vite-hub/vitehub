import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { it } from "vitest"

const execFile = promisify(execFileCallback)

it("renders a guarded Nuxt page and lists sessions at the HTTPS request origin", async () => {
  const cache = resolve(import.meta.dirname, "../../../.cache")
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, "nuxt-secure-session-"))
  try {
    const dependencies = ["@vite-hub/auth", "better-auth", "nitro", "nuxt", "vue"]
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const name of dependencies) {
      await symlink(resolve(import.meta.dirname, "../node_modules", name), join(root, "node_modules", name), "dir")
    }
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: Object.fromEntries(dependencies.map(name => [name, "*"])) }))
    await writeFile(join(root, "nuxt.config.ts"), `export default defineNuxtConfig({
  modules: ["@vite-hub/auth/nuxt"],
  nitro: { preset: "node-server", entry: "./server/entry.ts", experimental: { asyncContext: true } },
})
`)
    await mkdir(join(root, "server/middleware"), { recursive: true })
    await writeFile(join(root, "server/entry.ts"), `import { useNitroApp } from "nitro/app"

export default { fetch: useNitroApp().fetch }
`)
    await writeFile(join(root, "server/auth.ts"), `import { defineAuth } from "@vite-hub/auth"

export default defineAuth(() => ({ database: "memory", emailAndPassword: { enabled: true }, secret: "nuxt-test-secret-abcdefghijklmnopqrstuvwxyz" }))
`)
    await writeFile(join(root, "server/middleware/request-context.ts"), `import { defineMiddleware } from "nitro"
import { useRequest } from "nitro/context"

export default defineMiddleware((event) => {
  if (event.url.pathname.startsWith("/api/auth/") && useRequest().url !== event.req.url) {
    throw new Error("Auth did not receive its own Nitro request context")
  }
})
`)
    await mkdir(join(root, "app/pages"), { recursive: true })
    await writeFile(join(root, "app/pages/private.vue"), `<script setup>
definePageMeta({ auth: "user" })
const { data } = await useAuthClient().listSessions()
</script>
<template><div>Signed-in sessions: {{ data?.length }}</div></template>
`)
    await writeFile(join(root, "probe.mjs"), `import assert from "node:assert/strict"
import server from "./.output/server/index.mjs"

const origin = "https://app.example.com"
const signUp = await server.fetch(new Request(origin + "/api/auth/sign-up/email", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
}))
assert.equal(signUp.status, 200, await signUp.text())
const cookie = signUp.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ")
assert.match(cookie, /__Secure-better-auth[.]session_token=/)
const session = await server.fetch(new Request(origin + "/api/auth/get-session", { headers: { cookie } }))
assert.equal((await session.json()).user.email, "ada@example.com")
const page = await server.fetch(new Request(origin + "/private", { headers: { cookie, host: new URL(origin).host } }))
assert.equal(page.status, 200, page.headers.get("location"))
assert.match(await page.text(), /Signed-in sessions: 1/)
`)

    const { build, loadNuxt } = await import("nuxt")
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false, logLevel: "silent" } })
    try {
      await build(nuxt)
    }
    finally {
      await nuxt.close()
    }

    await execFile(process.execPath, ["probe.mjs"], { cwd: root, timeout: 15_000 })
  }
  finally {
    await rm(root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
