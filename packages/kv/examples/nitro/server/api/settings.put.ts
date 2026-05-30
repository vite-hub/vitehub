import { defineEventHandler } from "h3"
import { kv } from "@vite-hub/kv"

export default defineEventHandler(() => kv.set("settings", { enabled: true }))
