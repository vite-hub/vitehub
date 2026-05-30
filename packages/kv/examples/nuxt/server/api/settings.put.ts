import { kv } from "@vite-hub/kv"

export default defineEventHandler(() => kv.set("settings", { enabled: true }))
