import { Resend } from "resend";

const config = useRuntimeConfig();
const resend = new Resend(config.resendApiKey);

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const data = await resend.emails.send({ from: "Contact <contact@example.com>", to: ["me@example.com"], subject: "Contact", html: `<p>${body.message}</p>` });
  return data;
});
