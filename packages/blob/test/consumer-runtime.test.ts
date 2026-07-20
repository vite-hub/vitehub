import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { probePrivateVercelFunction } from "./private-vercel-probe.ts"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = resolve(packageRoot, "fixtures/private-vercel-consumer")

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
      },
    })
  } catch (error) {
    const failed = error as Error & { stderr?: string | Buffer, stdout?: string | Buffer }
    throw new Error(
      `${command} ${args.join(" ")} failed\n${failed.stdout || ""}${failed.stderr || ""}`,
      { cause: error },
    )
  }
}

describe("private Vercel Blob consumer runtime", () => {
  it(
    "builds and executes without a consumer-owned files-sdk dependency",
    { timeout: 120_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "vitehub-blob-private-vercel-consumer-"))
      const appDir = join(root, "app")
      const packDir = join(root, "packs")
      const stagedPackageRoot = join(root, "workspace/packages/blob")

      try {
        await Promise.all([
          cp(fixtureRoot, appDir, { recursive: true }),
          mkdir(packDir, { recursive: true }),
          mkdir(stagedPackageRoot, { recursive: true }),
        ])
        const sourceManifest = JSON.parse(
          await readFile(join(packageRoot, "package.json"), "utf8"),
        ) as { devDependencies?: Record<string, string>, version: string }
        delete sourceManifest.devDependencies
        await Promise.all([
          cp(join(packageRoot, "dist"), join(stagedPackageRoot, "dist"), { recursive: true }),
          cp(join(workspaceRoot, "pnpm-workspace.yaml"), join(root, "workspace/pnpm-workspace.yaml")),
          writeFile(
            join(stagedPackageRoot, "package.json"),
            `${JSON.stringify(sourceManifest, null, 2)}\n`,
            "utf8",
          ),
        ])
        await run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", packDir], stagedPackageRoot)

        const tarball = join(packDir, `vite-hub-blob-${sourceManifest.version}.tgz`)
        const { stdout: packedManifestJson } = await run(
          "tar",
          ["-xOf", tarball, "package/package.json"],
          appDir,
        )
        const packedManifest = JSON.parse(packedManifestJson) as {
          peerDependencies?: Record<string, string>
        }
        const vite = packedManifest.peerDependencies?.vite
        if (!vite) throw new Error("Packed @vite-hub/blob is missing its Vite peer range.")
        await writeFile(
          join(appDir, "package.json"),
          `${JSON.stringify(
            {
              dependencies: {
                "@vite-hub/blob": `file:${tarball}`,
                vite,
              },
              name: "vitehub-blob-private-vercel-consumer",
              packageManager: "pnpm@10.33.0",
              private: true,
              scripts: { build: "vite build" },
              type: "module",
            },
            null,
            2,
          )}\n`,
          "utf8",
        )
        await writeFile(
          join(appDir, "pnpm-workspace.yaml"),
          ["packages:", "  - .", "allowBuilds:", "  esbuild: true", ""].join("\n"),
          "utf8",
        )

        await run("pnpm", ["install", "--prod", "--no-hoist", "--strict-peer-dependencies"], appDir)

        const consumerManifest = JSON.parse(
          await readFile(join(appDir, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> }
        expect(consumerManifest.dependencies).not.toHaveProperty("files-sdk")
        expect(consumerManifest.dependencies).not.toHaveProperty("@vercel/blob")
        await run("pnpm", ["run", "build"], appDir)

        const runtimeModule = await readFile(
          join(appDir, ".vitehub/blob/vercel-runtime.mjs"),
          "utf8",
        )
        expect(runtimeModule).toContain("drivers/vercel-bundled")
        await probePrivateVercelFunction(appDir)
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    },
  )
})
