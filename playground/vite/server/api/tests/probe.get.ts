import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime-config"

export default defineEventHandler(() => {
  const { kv } = useRuntimeConfig()
  return {
    ok: true,
    provider: (kv && typeof kv === "object" && "store" in kv ? kv.store.driver : null),
  }
})
