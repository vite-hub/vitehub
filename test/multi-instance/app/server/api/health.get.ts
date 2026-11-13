import { defineHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime-config"

import { instance } from "../oracle"

export default defineHandler(() => ({
  buildRedis: useRuntimeConfig().multiInstanceBuildRedis,
  instance,
  serverRedis: process.env.REDIS_URL ? "set" : "unset",
}))
