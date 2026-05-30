import { kv } from "@vite-hub/kv"

export default defineEventHandler(() => kv.get("settings"))
