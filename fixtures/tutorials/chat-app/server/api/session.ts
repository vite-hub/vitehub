import { defineEventHandler, HTTPError, readValidatedBody } from "h3";
import { z } from "zod";
import { ownerSession, validPassword } from "../utils/session";

let attempts = 0;
let windowStart = Date.now();

export default defineEventHandler(async (event) => {
  const session = await ownerSession(event);
  if (event.method === "POST") {
    if (Date.now() - windowStart > 60_000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 10) throw new HTTPError({ status: 429, message: "Wait a minute before signing in." });
    const { password } = await readValidatedBody(event, z.object({ password: z.string().max(256) }).parse);
    if (!validPassword(password)) throw new HTTPError({ status: 401, message: "Incorrect password." });
    await session.update({ owner: "owner" });
  } else if (event.method === "DELETE") {
    await session.clear();
  } else if (event.method !== "GET") {
    throw new HTTPError({ status: 405 });
  }
  return { signedIn: session.data.owner === "owner", mode: process.env.CHAT_MODE || "offline" };
});
