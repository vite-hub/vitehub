import { env } from "../../env";

export default defineEventHandler(() => {
  return { port: env.SMTP_PORT, mock: env.MOCK_EMAIL, hasPassword: env.SMTP_PASS.length > 0 };
});
