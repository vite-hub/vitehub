import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"
import { definitionFeaturesRootPlugin, resolveDefinitionFeatures } from "../src/internal/definition-features.ts"
import { forgetPackageChecks } from "../src/internal/optional-owners.ts"

import type { ResolvedConfig } from "vite"

import type { ViteHubOptions } from "../src/plugins.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-definition-features-"))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  return root
}

function hidePackage(packageName: string) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return nextResolve(specifier, context)
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: "ERR_MODULE_NOT_FOUND" })
    },
  })
  forgetPackageChecks()
  return () => {
    hooks.deregister()
    forgetPackageChecks()
  }
}

describe("resolveDefinitionFeatures", () => {
  it("turns on each feature that has a Definition file and no key", () => {
    const projectRoot = project({
      "server/auth.ts": "export default {}\n",
      "server/databases/default.ts": "export default {}\n",
      "server/queues/welcome-email.ts": "export default {}\n",
      "server/realtime/presence.ts": "export default {}\n",
      "server/workflows/onboard-user.ts": "export default {}\n",
    })
    expect(resolveDefinitionFeatures({}, { projectRoot })).toEqual({ auth: true, database: true, queue: true, realtime: true, workflow: true })
  })

  it("keeps `false` off and keeps the options of an object", () => {
    const projectRoot = project({ "server/auth.ts": "export default {}\n", "server/queues/jobs.ts": "export default {}\n" })
    const options = { auth: false, queue: { driver: "memory" } }
    expect(resolveDefinitionFeatures(options, { projectRoot })).toBe(options)
  })

  it("leaves the options alone without Definition files", () => {
    const options: ViteHubOptions = { kv: true }
    expect(resolveDefinitionFeatures(options, { projectRoot: project({ "server/api/hello.ts": "export default {}\n" }) })).toBe(options)
  })

  it("reads the server directories of a Nuxt app and its layers", () => {
    const projectRoot = project({ "layers/base/server/schedules/cleanup.ts": "export default {}\n" })
    expect(resolveDefinitionFeatures({}, { projectRoot, serverDirs: [join(projectRoot, "server"), join(projectRoot, "layers/base/server")] })).toEqual({ schedule: true })
  })

  it("turns Agents on for a Channel file that receives webhooks", () => {
    const stripe = "import { defineChannel } from 'vite-hub/channels'\nimport { stripe } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: stripe() })\n"
    const alerts = "import { defineChannel } from 'vite-hub/channels'\nexport default defineChannel({ adapter: { kind: 'log', send: () => ({}) } })\n"
    expect(resolveDefinitionFeatures({}, { projectRoot: project({ "server/channels/payments.ts": stripe }) })).toEqual({ agent: true, channels: true })
    expect(resolveDefinitionFeatures({ channels: {} }, { projectRoot: project({ "server/channels/payments.ts": stripe }) })).toEqual({ agent: true, channels: {} })
    expect(resolveDefinitionFeatures({}, { projectRoot: project({ "server/channels/alerts.ts": alerts }) })).toEqual({ channels: true })
    const off = { agent: false } as const
    expect(resolveDefinitionFeatures(off, { projectRoot: project({ "server/channels/payments.ts": stripe }) })).toEqual({ agent: false, channels: true })
    expect(resolveDefinitionFeatures({ channels: false }, { projectRoot: project({ "server/channels/payments.ts": stripe }) })).toEqual({ channels: false })
  })

  it("asks for the Agent package when a webhook Channel needs it", () => {
    const projectRoot = project({ "server/channels/payments.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { webhook } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: webhook({ secret: false }) })\n" })
    const restore = hidePackage("@vite-hub/agent")
    let error: unknown
    try {
      resolveDefinitionFeatures({}, { projectRoot })
    }
    catch (caught) {
      error = caught
    }
    finally {
      restore()
    }
    expect(error).toMatchObject({
      code: "VITE_HUB_DEFINITION_PACKAGE_MISSING",
      message: expect.stringContaining("server/channels/payments.ts turns Agent on, but the app does not have @vite-hub/agent."),
    })
  })

  it("only enables the webhook host for Channels under the configured root", () => {
    const webhook = "import { defineChannel } from 'vite-hub/channels'\nimport { webhook } from 'vite-hub/channels/adapters'\nexport default defineChannel({ adapter: webhook({ secret: false }) })\n"
    const alert = "export default { adapter: { kind: 'log', send: () => ({}) } }\n"
    const config = { channels: { projectRoot: "custom" } }
    const roots = (projectRoot: string) => ({ projectRoot, viteRoot: join(projectRoot, "app"), serverDirs: [join(projectRoot, "server")] })
    const inbound = project({ "app/custom/server/channels/builds.ts": webhook, "server/channels/ignored.ts": alert })
    const outbound = project({ "app/custom/server/channels/alerts.ts": alert, "server/channels/ignored.ts": webhook })
    expect(resolveDefinitionFeatures(config, roots(inbound))).toEqual({ ...config, agent: true })
    expect(resolveDefinitionFeatures(config, roots(outbound))).toBe(config)
  })

  it("fails with the install command when the package of a Definition file is missing", () => {
    const projectRoot = project({ "server/auth.ts": "export default {}\n" })
    const restore = hidePackage("@vite-hub/auth")
    let error: unknown
    try {
      resolveDefinitionFeatures({}, { projectRoot })
    }
    catch (caught) {
      error = caught
    }
    finally {
      restore()
    }
    expect(viteHubErrorDiagnostics.VITE_HUB_DEFINITION_PACKAGE_MISSING.is(error)).toBe(true)
    expect(error).toMatchObject({
      fix: "Run `pnpm add @vite-hub/auth` in your app. To keep the feature off, set `auth: false` in the ViteHub options.",
      message: expect.stringContaining("server/auth.ts turns Auth on, but the app does not have @vite-hub/auth."),
    })
  })
})

describe("definitionFeaturesRootPlugin", () => {
  it("fails when the Vite root has other Definition files than the working directory", () => {
    const workingDirectory = project({ "package.json": "{}\n" })
    const root = project({ "package.json": "{}\n", "server/auth.ts": "export default {}\n" })
    const plugin = definitionFeaturesRootPlugin({}, { projectRoot: workingDirectory })
    const configResolved = plugin.configResolved as (config: ResolvedConfig) => void
    // SAFETY: The plugin reads only `root` and ViteHub's private keys.
    expect(() => configResolved({ root } as ResolvedConfig)).toThrow(expect.objectContaining({ code: "VITE_HUB_DEFINITION_ROOT_MISMATCH" }))
    // A key makes the feature independent of the folder.
    const keyed = definitionFeaturesRootPlugin({ auth: false }, { projectRoot: workingDirectory })
    expect(() => (keyed.configResolved as (config: ResolvedConfig) => void)({ root } as ResolvedConfig)).not.toThrow()
  })
})
