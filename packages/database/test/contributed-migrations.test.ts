import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectDatabaseContributions } from "../src/contributions.ts"
import { planContributedMigrations, toMigrationSql, writeContributedMigrations } from "../src/internal/contributed-migrations.ts"

import type { ResolvedDatabaseMigrations } from "../src/contributions.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createDirs() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-contributed-migrations-"))
  tempDirs.push(root)
  const source = join(root, "module/migrations")
  const migrationsDir = join(root, "server/databases/default/migrations")
  await mkdir(source, { recursive: true })
  await mkdir(join(migrationsDir, "20990101000000_init"), { recursive: true })
  await writeFile(join(migrationsDir, "20990101000000_init/migration.sql"), "CREATE TABLE `users` (`id` integer);\n")
  const contribution: ResolvedDatabaseMigrations = { database: "default", migrations: source, name: "feedback", plugin: "feedback/vite" }
  return { contribution, migrationsDir, source }
}

describe("contributed migrations", () => {
  it("validates `migrations` as an absolute folder on table contributions and uses", async () => {
    const plugin = (migrations: unknown) => ({ name: "feedback/vite", vitehub: { databases: [{ migrations, name: "feedback" }] } })
    await expect(collectDatabaseContributions([plugin("/srv/feedback/migrations")], { projectRoot: "/app", root: "/app", rootDir: "/app" })).resolves.toMatchObject({
      uses: [{ migrations: "/srv/feedback/migrations", name: "feedback", plugin: "feedback/vite" }],
    })
    await expect(collectDatabaseContributions([plugin("migrations")], { projectRoot: "/app", root: "/app", rootDir: "/app" })).rejects.toThrow("`migrations` of \"feedback\" must be the absolute path of a folder of `.sql` files.")
  })

  it("adds new files after the newest migration folder, once, and skips files of another dialect", async () => {
    const { contribution, migrationsDir, source } = await createDirs()
    await writeFile(join(source, "0002_votes.sql"), "CREATE TABLE votes (id integer); CREATE INDEX votes_id ON votes (id);")
    await writeFile(join(source, "0001_feedback.sqlite.sql"), "CREATE TABLE feedback (id integer);")
    await writeFile(join(source, "0001_feedback.postgresql.sql"), "CREATE TABLE feedback (id serial);")
    await writeFile(join(source, "README.md"), "not SQL")

    const plan = planContributedMigrations(migrationsDir, [contribution], "sqlite")
    expect(plan.pending.map(migration => migration.key)).toEqual(["feedback_0001_feedback", "feedback_0002_votes"])
    // The newest folder is in the future, so the new folders follow it and keep the file order.
    expect(writeContributedMigrations(migrationsDir, plan.pending, Date.UTC(2026, 10, 13))).toEqual([
      "20990101000001_feedback_0001_feedback",
      "20990101000002_feedback_0002_votes",
    ])
    expect(await readFile(join(migrationsDir, "20990101000002_feedback_0002_votes/migration.sql"), "utf8"))
      .toBe("CREATE TABLE votes (id integer);\n--> statement-breakpoint\nCREATE INDEX votes_id ON votes (id);\n")

    const again = planContributedMigrations(migrationsDir, [contribution], "sqlite")
    expect(again.pending).toEqual([])
    expect(again.added.map(migration => migration.folder)).toEqual(["20990101000001_feedback_0001_feedback", "20990101000002_feedback_0002_votes"])
    expect(planContributedMigrations("/missing", [contribution], "postgresql").pending.map(migration => basename(migration.file))).toEqual(["0001_feedback.postgresql.sql", "0002_votes.sql"])
    expect((await readdir(migrationsDir)).sort()).toEqual(["20990101000000_init", "20990101000001_feedback_0001_feedback", "20990101000002_feedback_0002_votes"])
  })

  it("keeps a file with statement breakpoints as written, and fails for a missing folder", async () => {
    const sql = "CREATE TRIGGER t AFTER INSERT ON votes BEGIN UPDATE votes SET id = id; END;\n--> statement-breakpoint\nSELECT 1;\n"
    expect(toMigrationSql(sql)).toBe(sql)
    const { contribution } = await createDirs()
    expect(() => planContributedMigrations("/missing", [{ ...contribution, migrations: "/missing/migrations" }], "sqlite"))
      .toThrow("The migrations folder /missing/migrations of \"feedback\" (from plugin \"feedback/vite\") does not exist.")
  })
})
