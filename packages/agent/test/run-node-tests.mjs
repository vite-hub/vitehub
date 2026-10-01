import { spawnSync } from "node:child_process"

const shard = process.env.VITEHUB_TEST_SHARD
const result = spawnSync(process.execPath, [
  "--test",
  ...(shard ? [`--test-shard=${shard}`] : []),
  ...process.argv.slice(2),
], { stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
