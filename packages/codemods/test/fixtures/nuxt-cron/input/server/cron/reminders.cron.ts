import { defineCronHandler } from "#nuxt/cron";

export default defineCronHandler(() => "*/5 * * * *", () => console.log("remind"), { timeZone: "America/New_York" });
