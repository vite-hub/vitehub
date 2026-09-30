import { appendFileSync, readFileSync } from "node:fs"
import { setTimeout } from "node:timers/promises"

const [phase, name] = process.argv.slice(2)
const log = process.env.VITEHUB_FIXTURE_LOG
const delay = Number(process.env.VITEHUB_FIXTURE_DELAY ?? 0)
const failures = new Map(
  (process.env.VITEHUB_FIXTURE_FAILURES ?? "")
    .split(",")
    .filter(Boolean)
    .map(entry => entry.split("=")),
)
const buildFailures = new Map(
  (process.env.VITEHUB_FIXTURE_BUILD_FAILURES ?? "")
    .split(",")
    .filter(Boolean)
    .map(entry => entry.split("=")),
)
const signals = new Set((process.env.VITEHUB_FIXTURE_SIGNALS ?? "").split(",").filter(Boolean))
const barrier = (process.env.VITEHUB_FIXTURE_TEST_BARRIER ?? "").split(",").filter(Boolean)

function record(event) {
  if (log) appendFileSync(log, `${phase}:${event}:${name}\n`)
}

process.on("SIGTERM", () => {
  record("signal")
  process.exit(143)
})

record("start")

if (phase === "test" && barrier.includes(name)) {
  const deadline = Date.now() + 15_000
  while (!barrier.every(peer => readFileSync(log, "utf8").includes(`test:start:${peer}\n`))) {
    if (Date.now() >= deadline) throw new Error("Parallel package tasks did not reach the start barrier")
    await setTimeout(10)
  }
}

await setTimeout(delay)

if (phase === "test" && signals.has(name)) {
  process.kill(process.pid, "SIGTERM")
  await setTimeout(10_000)
}

record("end")
process.exit(Number((phase === "build" ? buildFailures : failures).get(name) ?? 0))
