import { kv } from "@vitehub/kv"

export default defineEventHandler(() => kv.set("settings", { enabled: true }))
