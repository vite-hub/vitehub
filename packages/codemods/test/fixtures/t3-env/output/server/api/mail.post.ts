import { useServerEnv } from "vite-hub/env";

export default defineEventHandler(() => {
  return { port: useServerEnv().smtpPort, mock: useServerEnv().mockEmail, hasPassword: useServerEnv().smtpPass.unseal().length > 0 };
});
