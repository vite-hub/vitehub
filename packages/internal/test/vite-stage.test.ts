import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as vite from "vite"
import { expect, it } from "vitest"

import { loadAllEnv, withViteStageServer } from "../src/vite-stage.ts"

it.each([undefined, "config", false] as const)("loads Channel stage values from the resolved envDir (%s)", async (directory) => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-stage-env-"))
  const previous = process.env.VITEHUB_TEST_STAGE_ORIGIN
  const envDir = directory === "config" ? join(rootDir, directory) : directory
  try {
    await writeFile(join(rootDir, ".env.production"), "VITEHUB_TEST_STAGE_ORIGIN=https://root.example.com\n")
    if (typeof envDir === "string") {
      await mkdir(envDir)
      await writeFile(join(envDir, ".env.production"), "VITEHUB_TEST_STAGE_ORIGIN=https://stage.example.com\n")
    }
    for (const override of [undefined, "https://override.example.com"]) {
      const origin = await withViteStageServer(vite, {
        env: { ...process.env, VITEHUB_TEST_STAGE_ORIGIN: override },
        envDir,
        rootDir,
        stage: "production",
      }, async () => process.env.VITEHUB_TEST_STAGE_ORIGIN)
      expect(origin).toBe(override ?? (directory === false ? undefined : `https://${directory === "config" ? "stage" : "root"}.example.com`))
      expect(process.env.VITEHUB_TEST_STAGE_ORIGIN).toBe(previous)
    }
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})

it("drops the stderr writes of loadEnv and restores stderr after it, also when loadEnv throws", () => {
  const write = process.stderr.write
  const loadEnv = (mode: string, envDir: string | false, prefixes: string) => {
    process.stderr.write("vite:env using resolved env: { TOKEN: 'secret-canary' }\n")
    return { mode, envDir: String(envDir), prefixes }
  }
  const writes: unknown[] = []
  process.stderr.write = ((chunk: unknown) => writes.push(chunk) > 0) as typeof process.stderr.write
  try {
    expect(loadAllEnv(loadEnv, "production", "/app")).toEqual({ mode: "production", envDir: "/app", prefixes: "" })
    expect(() => loadAllEnv(() => { throw new Error("bad env file") }, "production", false)).toThrow("bad env file")
    process.stderr.write("after\n")
  }
  finally {
    process.stderr.write = write
  }
  expect(writes).toEqual(["after\n"])
})
