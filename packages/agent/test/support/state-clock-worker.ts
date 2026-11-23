import { createLibsqlAgentState } from "../../src/state/sqlite.ts"

const hostNow = Date.now.bind(Date)
const skewMs = Number(process.env.HOST_SKEW_MS)
Date.now = () => hostNow() + skewMs

const state = createLibsqlAgentState({ tablePrefix: process.env.STATE_TABLE_PREFIX, url: process.env.STATE_URL! })
await state.connect()

function hostTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hostTimes)
  if (typeof value !== "object" || value === null) return value
  if ("hostIn" in value && typeof value.hostIn === "number") return Date.now() + value.hostIn
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hostTimes(entry)]))
}

process.on("message", async (message: { args: unknown[]; id: number; method: string }) => {
  try {
    const method = Reflect.get(state, message.method)
    if (typeof method !== "function") throw new Error(`Unknown State method ${message.method}`)
    const value: unknown = await method.apply(state, hostTimes(message.args))
    process.send!({ id: message.id, value: value ?? null })
  } catch (error) {
    process.send!({ error: String(error), id: message.id })
  }
})
process.on("disconnect", () => void state.disconnect().finally(() => process.exit(0)))
process.send!({ ready: true })
