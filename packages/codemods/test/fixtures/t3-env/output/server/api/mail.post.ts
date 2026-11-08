import { useServerEnv } from "#vitehub/env/server";

export default defineEventHandler(() => {
  return { port: useServerEnv().smtpPort, mock: useServerEnv().mockEmail, hasPassword: useServerEnv().smtpPass.unseal().length > 0 };
});
