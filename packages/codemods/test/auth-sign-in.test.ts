import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/auth-sign-in-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("auth-sign-in", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

const nuxtConfig = [
  "export default defineNuxtConfig({",
  "  modules: ['vite-hub/nuxt'],",
  "  vitehub: {",
  "    host: 'cloudflare',",
  "    auth: { redirects: { login: '/sign-in', guest: '/dashboard' } },",
  "  },",
  "})",
  "",
].join("\n")

describe("auth-sign-in", () => {
  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("auth-sign-in")
    const { cwd } = await migrate({
      "nuxt.config.ts": nuxtConfig,
      "server/auth.ts": "import { defineAuth } from 'vite-hub/auth'\n\nexport default defineAuth({\n  access: {\n    routes: ['/dashboard/**'],\n  },\n})\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("auth-sign-in")
    await runCodemod("auth-sign-in", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe("export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt'],\n  vitehub: {\n    host: 'cloudflare',\n  },\n})\n")
    expect(await readFile(join(cwd, "server/auth.ts"), "utf8")).toBe("import { defineAuth } from 'vite-hub/auth'\n\nexport default defineAuth({\n  access: {\n    routes: ['/dashboard/**'],\n    signIn: '/sign-in',\n    afterSignIn: '/dashboard',\n  },\n})\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("auth-sign-in")
  })

  it("adds access to a Definition without it, from a Vite config", async () => {
    const { after } = await migrate({
      "vite.config.ts": "import { vitehub } from 'vite-hub/vite'\nexport default { plugins: [vitehub({ auth: { redirects: { login: '/login' } }, kv: true })] }\n",
      "server/auth.ts": "export default defineAuth({ appName: 'Docs' })\n",
    })
    expect(after).toEqual({
      "vite.config.ts": "import { vitehub } from 'vite-hub/vite'\nexport default { plugins: [vitehub({ kv: true })] }\n",
      "server/auth.ts": "export default defineAuth({ appName: 'Docs', access: { signIn: '/login' } })\n",
    })
  })

  it("moves signIn.callbackURL to afterSignIn", async () => {
    const { after } = await migrate({
      "server/auth.ts": "export default defineAuth({\n  access: {\n    routes: ['/**'],\n    signIn: { provider: 'github', callbackURL: '/app' },\n  },\n})\n",
    })
    expect(after).toEqual({
      "server/auth.ts": "export default defineAuth({\n  access: {\n    routes: ['/**'],\n    signIn: { provider: 'github' },\n    afterSignIn: '/app',\n  },\n})\n",
    })
  })

  it("reports a login page next to a provider sign-in", async () => {
    const { after, run } = await migrate({
      "nuxt.config.ts": nuxtConfig,
      "server/auth.ts": "export default defineAuth({\n  access: { signIn: { provider: 'github' } },\n})\n",
    })
    expect(after["server/auth.ts"]).toBe("export default defineAuth({\n  access: { signIn: { provider: 'github' }, afterSignIn: '/dashboard' },\n})\n")
    expect(run.result.followUps.map(entry => entry.message)).toEqual([expect.stringContaining("Keep one: the path of your sign-in page, or the provider")])
  })

  it("reports redirects that are not string literals, and keeps them", async () => {
    const { after, run } = await migrate({
      "nuxt.config.ts": "const login = '/login'\nexport default defineNuxtConfig({ vitehub: { auth: { redirects: { login } } } })\n",
      "server/auth.ts": "export default defineAuth({})\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "nuxt.config.ts", line: 2, message: expect.stringContaining("was removed") })])
  })
})
