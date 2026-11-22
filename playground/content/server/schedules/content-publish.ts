import { defineSchedule } from "vite-hub/schedule"

import content from "../content"

export default defineSchedule({
  cron: "* * * * *",
  manual: true,
  handler: () => content.publishDue(),
})
