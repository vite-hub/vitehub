import { defineEventHandler } from "h3"
import { kv } from "@vite-hub/kv"

export default defineEventHandler(() => kv.get("settings"))
