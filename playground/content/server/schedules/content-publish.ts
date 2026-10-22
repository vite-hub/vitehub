import { defineSchedule } from "vite-hub/schedule"

import { content } from "../content"

// Publishes scheduled Content every minute. `manual: true` also lets `vitehub schedule run content-publish` run it now.
export default defineSchedule({
  cron: "* * * * *",
  manual: true,
  handler: () => content.publishDue(),
})
