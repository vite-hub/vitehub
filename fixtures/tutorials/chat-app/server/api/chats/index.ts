import { createError, defineEventHandler } from "h3";
import { requireOwner } from "../../utils/session";
import { chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const store = chatStore();
  if (event.method === "GET") return store.list(owner);
  if (event.method !== "POST") throw createError({ statusCode: 405 });
  if (store.list(owner).length >= 100) {
    throw createError({ statusCode: 409, statusMessage: "Delete a chat before creating another." });
  }
  return store.create(owner);
});
