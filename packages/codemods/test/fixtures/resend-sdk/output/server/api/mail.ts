import { email } from "vite-hub/email";

const config = useRuntimeConfig();

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const data = await email.send({ from: "Contact <contact@example.com>", to: ["me@example.com"], subject: "Contact", html: `<p>${body.message}</p>` });
  return data;
});
