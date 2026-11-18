import { createHash, timingSafeEqual } from "node:crypto";
import { getHeader, HTTPError, type H3Event, useSession } from "h3";

export function appOrigin() {
  return process.env.CHAT_ORIGIN || "http://127.0.0.1:4318";
}

export function checkOrigin(event: H3Event) {
  if (getHeader(event, "origin") !== appOrigin()) {
    throw new HTTPError({ status: 403, message: "Use the app's own origin." });
  }
}

export function ownerSession(event: H3Event) {
  const password = process.env.CHAT_SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new HTTPError({ status: 503, message: "Set CHAT_SESSION_SECRET to at least 32 characters." });
  }
  return useSession<{ owner?: string }>(event, {
    name: "chat-owner",
    password,
    maxAge: 60 * 60 * 12,
    sessionHeader: false,
    cookie: { httpOnly: true, sameSite: "strict", secure: appOrigin().startsWith("https:") },
  });
}

export async function requireOwner(event: H3Event) {
  const session = await ownerSession(event);
  if (session.data.owner !== "owner") {
    throw new HTTPError({ status: 401, message: "Sign in first." });
  }
  return session.data.owner;
}

export function validPassword(value: string) {
  const expected = process.env.CHAT_PASSWORD;
  if (!expected || expected.length < 24) {
    throw new HTTPError({ status: 503, message: "Set CHAT_PASSWORD to at least 24 random characters." });
  }
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(value), digest(expected));
}
