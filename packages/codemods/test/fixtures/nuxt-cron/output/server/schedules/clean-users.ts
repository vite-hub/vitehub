import { defineSchedule } from "vite-hub/schedule";
import { removeStaleUsers } from "../utils/cleanup";

export default defineSchedule({
  cron: "0 0 * * *",
  handler: async () => {
    await removeStaleUsers();
    console.log("cleaned");
  },
});
