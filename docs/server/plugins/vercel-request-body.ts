import { defineNitroPlugin } from "nitro/runtime"
import { normalizeRequestBody } from "../utils/normalize-request-body"

const vercelRequestBodyPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event: any) => {
    normalizeRequestBody(event.req)
    normalizeRequestBody(event.node?.req)
  })
})

export default vercelRequestBodyPlugin
