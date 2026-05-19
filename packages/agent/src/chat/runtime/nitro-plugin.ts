import { definePlugin as defineNitroPlugin } from "nitro"

const chatNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin(async () => {
  if (!(import.meta as ImportMeta & { dev?: boolean }).dev) {
    return
  }

  const initializer = await import("@vitehub/agent/chat/runtime/nitro-dev-initialize")
  await initializer.default()
})

export default chatNitroPlugin
