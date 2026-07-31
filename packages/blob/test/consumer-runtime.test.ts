import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import { probePrivateVercelFunction } from "./private-vercel-probe.ts"

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, "..")
const workspaceRoot = resolve(packageRoot, "../..")
const fixtureRoot = resolve(packageRoot, "fixtures/private-vercel-consumer")
const cloudflareFixtureRoot = resolve(packageRoot, "fixtures/cloudflare-r2-consumer")
const awsRuntimePackages = [
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "@aws-sdk/s3-presigned-post",
  "@aws-sdk/s3-request-presigner",
]

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

describe("hosted Blob consumer runtime", () => {
  it(
    "builds private Vercel Blob and Cloudflare R2 without consumer provider dependencies",
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
        ) as { dependencies: Record<string, string>, devDependencies?: Record<string, string>, version: string }
        delete sourceManifest.devDependencies
        sourceManifest.dependencies["@vite-hub/runtime"] = "0.0.1"
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
        const runtimeManifest = JSON.parse(
          await readFile(join(workspaceRoot, "packages/runtime/package.json"), "utf8"),
        ) as { version: string }
        await run(
          "pnpm",
          ["--config.ignore-scripts=true", "pack", "--pack-destination", packDir],
          join(workspaceRoot, "packages/runtime"),
        )
        const runtimeTarball = join(packDir, `vite-hub-runtime-${runtimeManifest.version}.tgz`)
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
                "@vite-hub/runtime": `file:${runtimeTarball}`,
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
          [
            "packages:",
            "  - .",
            "allowBuilds:",
            "  esbuild: true",
            "overrides:",
            `  "@vite-hub/runtime": "file:${runtimeTarball}"`,
            "",
          ].join("\n"),
          "utf8",
        )

        await run("pnpm", ["install", "--prod", "--no-hoist", "--strict-peer-dependencies"], appDir)

        const consumerManifest = JSON.parse(
          await readFile(join(appDir, "package.json"), "utf8"),
        ) as { dependencies: Record<string, string> }
        expect(consumerManifest.dependencies).not.toHaveProperty("files-sdk")
        expect(consumerManifest.dependencies).not.toHaveProperty("@vercel/blob")
        for (const name of awsRuntimePackages) expect(consumerManifest.dependencies).not.toHaveProperty(name)
        await run("pnpm", ["run", "build"], appDir)

        const runtimeModule = await readFile(
          join(appDir, ".vitehub/blob/vercel-runtime.mjs"),
          "utf8",
        )
        expect(runtimeModule).toContain("drivers/vercel-bundled")
        await probePrivateVercelFunction(appDir)

        await cp(
          join(cloudflareFixtureRoot, "vite.config.ts"),
          join(appDir, "vite.config.ts"),
        )
        const awsResolveProbe = [
          `const blob = import.meta.resolve("@vite-hub/blob/package.json")`,
          `const packages = ${JSON.stringify(awsRuntimePackages)}`,
          `const reachable = packages.filter((specifier) => { try { import.meta.resolve(specifier, blob); return true } catch { return false } })`,
          `if (reachable.length) throw new Error("AWS runtime packages unexpectedly resolved: " + reachable.join(", "))`,
        ].join("\n")
        await run(
          "node",
          ["--experimental-import-meta-resolve", "--input-type=module", "--eval", awsResolveProbe],
          appDir,
        )
        await run("pnpm", ["run", "build"], appDir)

        const cloudflareRuntime = await readFile(
          join(appDir, ".vitehub/nitro/blob/runtime.mjs"),
          "utf8",
        )
        expect(cloudflareRuntime).toContain("drivers/cloudflare-native")
        const cloudflareOutput = await readFile(
          join(appDir, "dist/cloudflare/server.mjs"),
          "utf8",
        )
        expect(cloudflareOutput).not.toContain("files-sdk")
        expect(cloudflareOutput).not.toContain("@aws-sdk/")
        const cloudflareSignProbe = [
          `process.env.R2_ACCOUNT_ID = "account"`,
          `process.env.R2_ACCESS_KEY_ID = "access-key"`,
          `process.env.R2_SECRET_ACCESS_KEY = "secret-key"`,
          `const { blob } = await import(${JSON.stringify(pathToFileURL(join(appDir, ".vitehub/nitro/blob/runtime.mjs")).href)})`,
          `const [error, signed] = await blob.sign("proof/private.txt", { expiresIn: 60, method: "GET" })`,
          `if (error) throw error`,
          `const url = new URL(signed.url)`,
          `if (url.hostname !== "account.r2.cloudflarestorage.com") throw new Error("Unexpected R2 signing host")`,
          `if (url.searchParams.get("X-Amz-Expires") !== "60") throw new Error("Unexpected R2 signing expiry")`,
          `if (!url.searchParams.get("X-Amz-Signature")) throw new Error("Missing R2 signature")`,
        ].join("\n")
        await run("node", ["--input-type=module", "--eval", cloudflareSignProbe], appDir)
        await expect(
          readFile(join(appDir, ".vercel/output/functions/__server.func/index.mjs"), "utf8"),
        ).resolves.toContain("createBlobVercelServer")
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    },
  )
})
