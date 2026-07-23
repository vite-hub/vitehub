import { H3 } from "h3"
import { kv } from "@vite-hub/kv"

const app = new H3()
  .get("/", async () => {
    const [error, settings] = await kv.get("settings")
    if (error) throw error
    return settings
  })
  .put("/", async () => {
    const [error] = await kv.set("settings", { enabled: true })
    if (error) throw error
  })
  .delete("/", async () => {
    const [error] = await kv.del("settings")
    if (error) throw error
  })

export default app
