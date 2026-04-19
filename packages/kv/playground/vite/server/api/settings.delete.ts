import { defineEventHandler } from "nitro/h3"
import { kv } from "@vitehub/kv"

export default defineEventHandler(() => kv.del("settings"))
