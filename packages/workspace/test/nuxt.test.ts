import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import workspaceNuxt from "../src/nuxt.ts"
import { createWorkspaceNitroConfig } from "../src/vite.ts"

import type { WorkspaceModuleOptions } from "../src/core/types.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createNuxtHook(store: WorkspaceModuleOptions["store"] = { provider: "memory" }, aliases?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nuxt-artifacts-"))
  tempDirs.push(root)
  let nitroConfigHook: ((nitroConfig: Record<string, unknown>) => void | Promise<void>) | undefined
  const nuxt = {
    hook(name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>) {
      if (name === "nitro:config") nitroConfigHook = handler
    },
    options: {
      alias: aliases,
      dev: false,
      rootDir: root,
      srcDir: root,
      vite: {},
    },
  }

  workspaceNuxt({ store }, nuxt)
  expect(nitroConfigHook).toBeDefined()
  return { nitroConfigHook: nitroConfigHook!, root }
}

describe("Workspace Nuxt module", () => {
  it("registers collection composables once", () => {
    const nuxt = {
      options: {
        imports: {
          imports: [{ from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollection" }],
        },
        vite: { plugins: [] },
      },
    }

    workspaceNuxt({}, nuxt as never)
    workspaceNuxt({}, nuxt as never)

    expect(nuxt.options.imports.imports).toEqual([
      { from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollection" },
      { from: "@vite-hub/workspace/collections/client", name: "useWorkspaceCollectionItem" },
    ])
  })

  it("registers the default Cloudflare Artifacts binding and runtime in generated Nitro config", async () => {
    const { nitroConfigHook, root } = await createNuxtHook({ provider: "cloudflare-artifacts" })
    const nitroConfig: Record<string, unknown> = {
      cloudflare: {
        wrangler: {
          artifacts: [{ binding: "EXISTING_ARTIFACTS", namespace: "existing" }],
          observability: { enabled: true },
        },
      },
    }

    await nitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      cloudflare: {
        wrangler: {
          artifacts: [
            { binding: "EXISTING_ARTIFACTS", namespace: "existing" },
            { binding: "WORKSPACE_ARTIFACTS", namespace: "vitehub" },
          ],
          compatibility_flags: ["nodejs_compat"],
          observability: { enabled: true },
        },
      },
      plugins: [".vitehub/nitro/workspace/plugin.ts"],
      rollupConfig: { external: ["cloudflare:workers"] },
    })
    const plugin = await readFile(join(root, ".vitehub", "nitro", "workspace", "plugin.ts"), "utf8")
    expect(plugin).toContain("import { env as vitehubEnv } from 'cloudflare:workers'")
    expect(plugin).toContain("setActiveCloudflareEnv(vitehubEnv)")
  })

  it("registers Cloudflare Artifacts bindings from Workspace Definitions", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    await mkdir(join(root, "server", "workspaces"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "reports.ts"), [
      "export default {",
      "  store: { binding: 'REPORT_ARTIFACTS', namespace: 'reports', provider: 'cloudflare-artifacts' },",
      "}",
      "",
    ].join("\n"))

    const nitroConfig: Record<string, unknown> = {}
    await nitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      cloudflare: {
        wrangler: {
          artifacts: [
            { binding: "REPORT_ARTIFACTS", namespace: "reports" },
          ],
        },
      },
    })
  })

  it("resolves Definition bindings from the Nitro environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nuxt-env-"))
    tempDirs.push(root)
    await mkdir(join(root, "server", "workspaces"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "reports.ts"), [
      "export default { store: { provider: 'cloudflare-artifacts' } }",
      "",
    ].join("\n"))

    await expect(createWorkspaceNitroConfig({
      env: { WORKSPACE_ARTIFACTS_BINDING: "ENV_ARTIFACTS", WORKSPACE_ARTIFACTS_NAMESPACE: "environment" },
      viteRoot: root,
    })).resolves.toMatchObject({
      cloudflare: { wrangler: { artifacts: [{ binding: "ENV_ARTIFACTS", namespace: "environment" }] } },
    })
    const registry = await readFile(join(root, ".vitehub", "nitro", "workspace", "registry.js"), "utf8")
    expect(registry).toContain('store: {"binding":"ENV_ARTIFACTS","namespace":"environment","provider":"cloudflare-artifacts"')
  })

  it("does not load non-Artifact Workspace Definitions before Nuxt aliases are available", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    await mkdir(join(root, "server", "workspaces"), { recursive: true })
    await writeFile(join(root, "server", "workspaces", "aliased.ts"), [
      "import { workspaceRoot } from '~/workspace-options'",
      "export default { root: workspaceRoot, store: { provider: 'memory' } }",
      "",
    ].join("\n"))

    await expect(nitroConfigHook({})).resolves.toBeUndefined()
  })

  it("ignores type-only imports when detecting Artifact Workspace Definitions", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    const definitionRoot = join(root, "server", "workspaces")
    await mkdir(definitionRoot, { recursive: true })
    await writeFile(join(definitionRoot, "artifact-options.ts"), "export type ArtifactOptions = { provider: 'cloudflare-artifacts' }\n")
    await writeFile(join(definitionRoot, "typed.ts"), [
      "import { type ArtifactOptions, } from './artifact-options'",
      "import { workspaceRoot } from '#imports'",
      "export default { root: workspaceRoot, store: { provider: 'memory' } } satisfies { store: ArtifactOptions | { provider: 'memory' } }",
      "",
    ].join("\n"))

    await expect(nitroConfigHook({})).resolves.toBeUndefined()
  })

  it("ignores non-runtime Artifact provider references in Workspace Definitions", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    const definitionRoot = join(root, "server", "workspaces")
    await mkdir(definitionRoot, { recursive: true })
    await writeFile(join(definitionRoot, "typed.ts"), [
      "type ArtifactStore = {",
      "  provider: 'cloudflare-artifacts'",
      "}",
      "interface NestedStore { store: { provider: 'cloudflare-artifacts' } }",
      "// provider: 'cloudflare-artifacts'",
      "const example = \"provider: 'cloudflare-artifacts'\"",
      "const unrelated = { provider: 'cloudflare-artifacts' }",
      "import { workspaceRoot } from '#imports'",
      "export default { root: workspaceRoot, example, unrelated, store: { provider: 'memory' } } satisfies NestedStore | { store: ArtifactStore | { provider: 'memory' } }",
      "",
    ].join("\n"))

    await expect(nitroConfigHook({})).resolves.toBeUndefined()
  })

  it("surfaces unresolved runtime Artifact Workspace Definitions", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    const definitionRoot = join(root, "server", "workspaces")
    await mkdir(definitionRoot, { recursive: true })
    await writeFile(join(definitionRoot, "artifacts.ts"), [
      "import { workspaceRoot } from '#imports'",
      "export default { root: workspaceRoot, store: { provider: 'cloudflare-artifacts' as const } }",
      "",
    ].join("\n"))

    await expect(nitroConfigHook({})).rejects.toThrow("Cannot find module '#imports'")
  })

  it("registers a Definition binding configured through a Nuxt alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-nuxt-alias-"))
    tempDirs.push(root)
    const optionsFile = join(root, "workspace-options.ts")
    const { nitroConfigHook, root: nuxtRoot } = await createNuxtHook({ provider: "memory" }, { "#workspace-options": optionsFile })
    const definitionRoot = join(nuxtRoot, "server", "workspaces")
    await mkdir(definitionRoot, { recursive: true })
    await writeFile(optionsFile, "export const store = { binding: 'ALIAS_ARTIFACTS', namespace: 'alias', provider: 'cloudflare-artifacts' } as const\n")
    await writeFile(join(definitionRoot, "aliased-artifacts.ts"), [
      "import { store } from '#workspace-options'",
      "export default { store }",
      "",
    ].join("\n"))

    const nitroConfig: Record<string, unknown> = {}
    await nitroConfigHook(nitroConfig)
    expect(nitroConfig).toMatchObject({
      cloudflare: { wrangler: { artifacts: [{ binding: "ALIAS_ARTIFACTS", namespace: "alias" }] } },
    })
  })

  it("registers a Definition binding with a computed provider", async () => {
    const { nitroConfigHook, root } = await createNuxtHook()
    const definitionRoot = join(root, "server", "workspaces")
    await mkdir(definitionRoot, { recursive: true })
    await writeFile(join(definitionRoot, "computed-artifacts.ts"), [
      "const provider = ['cloudflare', 'artifacts'].join('-')",
      "export default { store: { binding: 'COMPUTED_ARTIFACTS', namespace: 'computed', provider } }",
      "",
    ].join("\n"))

    const nitroConfig: Record<string, unknown> = {}
    await nitroConfigHook(nitroConfig)
    expect(nitroConfig).toMatchObject({
      cloudflare: { wrangler: { artifacts: [{ binding: "COMPUTED_ARTIFACTS", namespace: "computed" }] } },
    })
  })

  it("deduplicates an existing custom Cloudflare Artifacts binding", async () => {
    const { nitroConfigHook } = await createNuxtHook({
      binding: "CUSTOM_ARTIFACTS",
      namespace: "custom-workspaces",
      provider: "cloudflare-artifacts",
    })
    const nitroConfig: Record<string, unknown> = {
      cloudflare: {
        wrangler: {
          artifacts: [{ binding: "CUSTOM_ARTIFACTS", namespace: "custom-workspaces" }],
        },
      },
    }

    await nitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      cloudflare: {
        wrangler: {
          artifacts: [{ binding: "CUSTOM_ARTIFACTS", namespace: "custom-workspaces" }],
        },
      },
      plugins: [".vitehub/nitro/workspace/plugin.ts"],
    })
  })

  it("rejects a custom binding already assigned to another namespace", async () => {
    const { nitroConfigHook } = await createNuxtHook({
      binding: "CUSTOM_ARTIFACTS",
      namespace: "workspace",
      provider: "cloudflare-artifacts",
    })

    await expect(nitroConfigHook({
      cloudflare: {
        wrangler: {
          artifacts: [{ binding: "CUSTOM_ARTIFACTS", namespace: "application" }],
        },
      },
    })).rejects.toThrow("cannot use both namespace")
  })
})
