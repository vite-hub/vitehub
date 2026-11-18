import { defineEventHandler, getRouterParam, HTTPError } from "h3";
import { requireOwner } from "../../utils/session";
import { activeChats, chatStore } from "../../utils/store";

export default defineEventHandler(async (event) => {
  const owner = await requireOwner(event);
  const id = getRouterParam(event, "id") || "";
  const store = chatStore();
  const thread = store.get(owner, id);
  if (!thread) throw new HTTPError({ status: 404 });
  if (event.method === "GET") return thread;
  if (event.method !== "DELETE") throw new HTTPError({ status: 405 });
  if (activeChats.has(id)) throw new HTTPError({ status: 409, message: "Wait for the reply to finish." });
  store.remove(owner, id);
  return { deleted: true };
});
