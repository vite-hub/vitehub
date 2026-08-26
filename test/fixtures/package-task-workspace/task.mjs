import { appendFileSync } from "node:fs"

const [phase, name] = process.argv.slice(2)
const log = process.env.VITEHUB_FIXTURE_LOG
const delay = Number(process.env.VITEHUB_FIXTURE_DELAY ?? 0)
const failures = new Map(
  (process.env.VITEHUB_FIXTURE_FAILURES ?? "")
    .split(",")
    .filter(Boolean)
    .map(entry => entry.split("=")),
)
const signals = new Set((process.env.VITEHUB_FIXTURE_SIGNALS ?? "").split(",").filter(Boolean))

function record(event) {
  if (log) appendFileSync(log, `${phase}:${event}:${name}\n`)
}

record("start")

process.on("SIGTERM", () => {
  record("signal")
  process.exit(143)
})

await new Promise(resolve => setTimeout(resolve, delay))

if (phase === "test" && signals.has(name)) {
  process.kill(process.pid, "SIGTERM")
  await new Promise(resolve => setTimeout(resolve, 10_000))
}

record("end")
process.exit(phase === "test" ? Number(failures.get(name) ?? 0) : 0)
