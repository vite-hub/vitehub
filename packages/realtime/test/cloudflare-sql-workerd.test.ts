import { readFileSync } from "node:fs"
import { Miniflare } from "miniflare"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { expect, it } from "vitest"

it("accepts native workerd SQLite while rejecting copied and polluted SQL carriers", async () => {
  const helper = transpileModule(readFileSync(new URL("../src/cloudflare-sql.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
  }).outputText
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-30",
    durableObjects: { ROOM: { className: "Room", useSQLite: true } },
    modules: true,
    script: `${helper}
      export class Room {
        constructor(context) { this.context = context }
        fetch() {
          const sql = this.context.storage.sql
          const genuine = hasCloudflareSqlExec(sql)
          const counterfeit = hasCloudflareSqlExec(Object.create(Object.getPrototypeOf(sql)))
          let getterCalls = 0
          Object.defineProperty(Object.prototype, "exec", {
            configurable: true,
            get() { getterCalls++; throw new Error("polluted executor") },
          })
          const polluted = hasCloudflareSqlExec({})
          delete Object.prototype.exec
          if (!genuine) throw new Error("native SqlStorage was rejected")
          sql.exec("CREATE TABLE proof (id INTEGER)")
          sql.exec("INSERT INTO proof VALUES (1)")
          return Response.json({ genuine, counterfeit, polluted, getterCalls, rows: sql.exec("SELECT id FROM proof").toArray() })
        }
      }
      export default {
        fetch(request, env) { return env.ROOM.get(env.ROOM.idFromName("proof")).fetch(request) }
      }
    `,
  })
  try {
    const response = await runtime.dispatchFetch("https://example.com/")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      genuine: true,
      counterfeit: false,
      polluted: false,
      getterCalls: 0,
      rows: [{ id: 1 }],
    })
  }
  finally {
    await runtime.dispose()
  }
}, 30_000)
