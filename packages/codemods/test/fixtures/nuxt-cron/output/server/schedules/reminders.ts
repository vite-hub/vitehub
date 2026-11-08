import { defineSchedule } from "vite-hub/schedule";

export default defineSchedule({ cron: "*/5 * * * *", timeZone: "America/New_York", handler: () => console.log("remind") });
