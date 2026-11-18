import { defineEventHandler, HTTPError } from "h3";
import { requireOwner } from "../../utils/session";
import { chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const store = chatStore();
  if (event.method === "GET") return store.list(owner);
  if (event.method !== "POST") throw new HTTPError({ status: 405 });
  if (store.list(owner).length >= 100) {
    throw new HTTPError({ status: 409, message: "Delete a chat before creating another." });
  }
  return store.create(owner);
});
