import { H3 } from "h3"

import registry from "#vitehub/schedule/registry"
import { runSchedule } from "@vite-hub/schedule/runtime"

const app = new H3()

app.post("/api/schedules/database-cleanup/run", async () => {
  const run = await runSchedule("database-cleanup", { registry })
  return { id: run.id, status: run.status }
})

export default app
