import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { classify, resolveSpecifier } from "../src/t3-env/call-sites.ts"
import { envPathOf } from "../src/t3-env/plan.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe.each([
  ["t3-env", "an env module that only Nuxt code imports"],
  ["t3-env-outside", "an env module that a config outside Nuxt also imports"],
])("t3-env with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("t3-env", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after ?? "(deleted)\n").toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("t3-env helpers", () => {
  it("names Env fields after the variable without its Nuxt prefix", () => {
    expect(envPathOf("DATABASE_URL", "server")).toBe("databaseUrl")
    expect(envPathOf("NUXT_SESSION_PASSWORD", "server")).toBe("sessionPassword")
    expect(envPathOf("NUXT_PUBLIC_APP_URL", "public")).toBe("appUrl")
  })

  it("classifies files by where Nuxt runs them", () => {
    expect(classify("server/api/x.ts")).toBe("server")
    expect(classify("plugins/auth.server.ts")).toBe("server")
    expect(classify("app/pages/index.vue")).toBe("app")
    expect(classify("components/Card.vue")).toBe("app")
    expect(classify("shared/utils.ts")).toBe("shared")
    expect(classify("db/index.ts")).toBe("shared")
    expect(classify("drizzle.config.ts")).toBe("outside")
    expect(classify("scripts/seed.ts")).toBe("outside")
  })

  it("resolves ~ and @ to both source directory candidates", () => {
    const cwd = join(fixtures, "t3-env/input")
    expect(resolveSpecifier(cwd, "server/a.ts", "@/server/env")).toEqual(["app/server/env", "server/env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "~~/env.ts")).toEqual(["env"])
    expect(resolveSpecifier(cwd, "server/api/a.ts", "../../env")).toEqual(["env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "#shared/env")).toEqual(["shared/env"])
    expect(resolveSpecifier(cwd, "server/a.ts", "zod")).toEqual([])
  })
})
