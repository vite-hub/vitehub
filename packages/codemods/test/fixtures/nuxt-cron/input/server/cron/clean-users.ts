import { defineCronHandler } from "#nuxt/cron";
import { removeStaleUsers } from "../utils/cleanup";

export default defineCronHandler(
  "daily",
  async () => {
    await removeStaleUsers();
    console.log("cleaned");
  },
);
