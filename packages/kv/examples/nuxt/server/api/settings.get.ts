import { kv } from "@vitehub/kv"

export default defineEventHandler(() => kv.get("settings"))
