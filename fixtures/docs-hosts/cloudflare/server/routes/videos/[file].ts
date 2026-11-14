import { defineEventHandler, getRouterParam } from "h3";
import { getHostBinding } from "vite-hub/runtime";

export default defineEventHandler(async (event) => {
  const [error, bucket] = getHostBinding("VIDEOS", event);
  if (error) return new Response(null, { status: 404 });
  const object = await bucket.get(`videos/${getRouterParam(event, "file")}`);
  return object ? new Response(object.body) : new Response(null, { status: 404 });
});
