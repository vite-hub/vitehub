import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder } from "vite"
import { expect, it, vi } from "vitest"

import { vitehub } from "../src/index.ts"
import type { ViteHubOptions } from "../src/plugins.ts"

import type { OptionalFeature } from "../src/internal/optional-owners.ts"

// The repository installs Forge, so the test plays an app that did not.
vi.mock("../src/internal/optional-owners.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/internal/optional-owners.ts")>()
  return {
    ...original,
    assertFeaturePackages: (features: readonly OptionalFeature[], ...rest: Parameters<typeof original.assertFeaturePackages> extends [unknown, ...infer R] ? R : never) => {
      if (features.includes("forge")) throw original.missingFeaturePackagesError(features)
      original.assertFeaturePackages(features, ...rest)
    },
    isPackageInstalled: (name: string) => name !== "@vite-hub/forge" && original.isPackageInstalled(name),
  }
})

const packages = resolve(import.meta.dirname, "../..")

async function build(route: string, { options, definition, generatedRoute }: {
  options?: ViteHubOptions
  definition?: string
  generatedRoute?: boolean
} = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-forge-build-check-"))
  try {
    await mkdir(join(root, "node_modules/@vite-hub"), { recursive: true })
    for (const owner of ["agent", "source", "workspace"]) {
      await symlink(join(packages, owner), join(root, `node_modules/@vite-hub/${owner}`), "dir")
    }
    await symlink(join(packages, "vite-hub"), join(root, "node_modules/vite-hub"), "dir")
    await symlink(join(packages, "vite-hub/node_modules/h3"), join(root, "node_modules/h3"), "dir")
    await mkdir(join(root, "server/routes"), { recursive: true })
    await mkdir(join(root, "docs"), { recursive: true })
    await writeFile(join(root, "docs/intro.md"), "# Intro\n")
    const generatedRouteId = join(root, "generated/docs.ts")
    await writeFile(join(root, "server/routes/docs.ts"), generatedRoute ? "export { default } from 'virtual:forge-docs'" : route)
    if (definition) {
      await mkdir(join(root, "server/workspaces"), { recursive: true })
      await writeFile(join(root, "server/workspaces/docs.ts"), definition)
    }
    const { nitro } = await import("nitro/vite" as string) as { nitro: () => unknown }
    const builder = await createBuilder({
      logLevel: "silent",
      root,
      plugins: [vitehub({ host: "cloudflare", env: false, ...options }), nitro() as never, {
        name: "test:optional-discord-compression",
        resolveId: (id: string) => id === "zlib-sync" ? { id, external: true } : undefined,
      }, {
        name: "test:generated-forge-route",
        resolveId: (id: string) => generatedRoute && id === "virtual:forge-docs" ? generatedRouteId : undefined,
        load: (id: string) => id === generatedRouteId ? route : undefined,
      }],
    } as Parameters<typeof createBuilder>[0])
    await builder.buildApp()
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it("stops the build when a github() Source needs the Forge package that the app did not install", async () => {
  await expect(build([
    "import { github } from 'vite-hub/source'",
    "const docs = github({ repo: 'vite-hub/vitehub', ref: 'main', root: 'docs' })",
    "export default async () => await docs.getKeys({})",
    "",
  ].join("\n"))).rejects.toMatchObject({
    // Rolldown reports the plugin error inside its build error.
    errors: [expect.objectContaining({ pluginCode: "VITE_HUB_R0136", plugin: "vite-hub/forge-build-check", message: expect.stringContaining("pnpm add @vite-hub/forge") })],
  })
}, 120_000)

it("builds a generated module that imports vite-hub/source without github()", async () => {
  await expect(build([
    "import { github, glob } from 'vite-hub/source'",
    "const docs = glob({ cwd: 'docs', include: '**/*.md' })",
    "export default async () => await docs.getKeys({})",
    "",
  ].join("\n"), { generatedRoute: true })).resolves.toBeUndefined()
}, 120_000)

it("stops the build when server code selects the Workspace GitHub Source", async () => {
  await expect(build(`
    import { github as repository } from 'vite-hub/workspace'
    const docs = repository({ repo: 'vite-hub/vitehub' })
    export default async () => await docs.getKeys({})
  `)).rejects.toMatchObject({
    errors: [expect.objectContaining({ pluginCode: "VITE_HUB_R0136", plugin: "vite-hub/forge-build-check" })],
  })
}, 120_000)

it("builds a route that uses an inline memory Workspace without Forge", async () => {
  await expect(build(`
    import { createWorkspace, defineWorkspace } from 'vite-hub/workspace'
    const docs = createWorkspace({ name: 'docs', ...defineWorkspace({ store: { driver: 'memory' } }) })
    export default async () => await docs.list()
  `)).resolves.toBeUndefined()
}, 120_000)

it("builds a route that uses a Web Chat Agent without Forge", async () => {
  await expect(build(`
    import { defineAgent } from 'vite-hub/agent'
    import { webChat } from 'vite-hub/channels/adapters'
    const agent = defineAgent({ channels: { web: webChat() }, driver: { run: () => 'ok' } })
    export default () => Object.keys(agent.channels)
  `)).resolves.toBeUndefined()
}, 120_000)

it("requires Forge when a discovered Workspace selects the GitHub store", async () => {
  await expect(build("export default () => 'ok'", {
    options: { workspace: true },
    definition: `
      import { defineWorkspace } from 'vite-hub/workspace'
      export default defineWorkspace({ store: { driver: 'github', repo: 'vite-hub/vitehub' } })
    `,
  })).rejects.toMatchObject({
    code: "VITE_HUB_R0136",
    message: expect.stringContaining("pnpm add @vite-hub/forge"),
  })
}, 120_000)
