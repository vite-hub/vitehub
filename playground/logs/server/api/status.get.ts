import { useLogger } from "evlog/nitro/v3";
import { defineHandler } from "nitro/h3";

export default defineHandler((event) => {
  useLogger(event).set({ message: "Status checked", deployment: { environment: "development" } });
  return { ok: true };
});
