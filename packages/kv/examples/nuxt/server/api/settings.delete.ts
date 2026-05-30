import { kv } from "@vite-hub/kv"

export default defineEventHandler(() => kv.del("settings"))
