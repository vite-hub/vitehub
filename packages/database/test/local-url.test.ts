import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"

import { afterEach, describe, expect, it } from "vitest"

import { resolveLocalSqliteUrl } from "../src/runtime/local-url.ts"
import { resolveLocalSqlitePath } from "../src/runtime/local-path.ts"

const tempDirs: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it.each(["libsql://test.invalid/db", "https://test.invalid/db", "ws://test.invalid/db", "wss://test.invalid/db", ":memory:", "file::memory:", "file::memory:?cache=shared"])("does not create local directories for %s", async (url) => {
  const tempDir = await mkdtemp(join(import.meta.dirname, ".local-url-"))
  tempDirs.push(tempDir)
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", [
    `import { resolveLocalSqliteUrl } from ${JSON.stringify(new URL("../src/runtime/local-url.ts", import.meta.url).href)}`,
    `console.log(resolveLocalSqliteUrl(${JSON.stringify(url)}))`,
  ].join("\n")], { cwd: tempDir })
  expect(stdout.trim()).toBe(url)
  expect(await readdir(tempDir)).toEqual([])
})

it.each(["file", "FILE", "localhost"])("prepares the decoded path of a %s URL for libSQL", async (scheme) => {
  const tempDir = await mkdtemp(join(import.meta.dirname, ".local-url-"))
  tempDirs.push(tempDir)
  const databaseFile = join(tempDir, "space in directory", "sqlite.db")
  const fileUrl = pathToFileURL(databaseFile)
  const url = scheme === "localhost" ? `file://localhost${fileUrl.pathname}` : fileUrl.href.replace(/^file:/, `${scheme}:`)
  resolveLocalSqliteUrl(url)
  const client = createClient({ url })
  try {
    expect((await client.execute("SELECT 1 AS value")).rows[0]).toMatchObject({ value: 1 })
    expect(existsSync(databaseFile)).toBe(true)
  }
  finally {
    client.close()
  }
})

describe("resolveLocalSqlitePath", () => {
  it("strips the complete file scheme, including localhost URLs", () => {
    expect(resolveLocalSqlitePath("FILE:folder%20with%20spaces/sqlite.db?mode=rwc")).toBe("folder with spaces/sqlite.db")
    expect(resolveLocalSqlitePath("file://localhost/tmp/vitehub/database.sqlite?mode=rwc")).toBe("/tmp/vitehub/database.sqlite")
    expect(resolveLocalSqlitePath("file:/tmp/vitehub/database.sqlite")).toBe("/tmp/vitehub/database.sqlite")
  })
})
