// One process of the cross-process write test for local libSQL files. It waits for the shared start time, inserts
// `writes` rows with four statements in flight, and prints how many succeeded and the errors as one JSON line.
import { createLocalSqliteClient } from "../../src/runtime/local-client.ts"

const [file, writes, startAt, timeout] = process.argv.slice(2)
const client = createLocalSqliteClient({ url: `file:${file}`, ...(timeout === "default" ? {} : { timeout: Number(timeout) }) })
await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
let written = 0
const errors: string[] = []
let next = 0
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < Number(writes)) {
    const index = next++
    try {
      await client.execute({ args: [process.pid, index], sql: "insert into writes (pid, n) values (?, ?)" })
      written++
    }
    catch (error) {
      errors.push(String(error))
    }
  }
}))
client.close()
console.log(JSON.stringify({ errors: errors.slice(0, 3), errorCount: errors.length, pid: process.pid, written }))
