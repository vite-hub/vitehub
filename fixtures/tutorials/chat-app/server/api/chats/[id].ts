import { createError, defineEventHandler, getRouterParam } from "h3";
import { requireOwner } from "../../utils/session";
import { activeChats, chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const id = getRouterParam(event, "id") || "";
  const store = chatStore();
  const thread = store.get(owner, id);
  if (!thread) throw createError({ statusCode: 404 });
  if (event.method === "GET") return thread;
  if (event.method !== "DELETE") throw createError({ statusCode: 405 });
  if (activeChats.has(id)) throw createError({ statusCode: 409, statusMessage: "Wait for the reply to finish." });
  store.remove(owner, id);
  return { deleted: true };
});
