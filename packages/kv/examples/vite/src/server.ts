import { H3 } from "h3"
import { kv } from "@vite-hub/kv"

const app = new H3()
  .get("/", async () => await kv.get("settings"))
  .put("/", async () => await kv.set("settings", { enabled: true }))
  .delete("/", async () => await kv.del("settings"))

export default app
