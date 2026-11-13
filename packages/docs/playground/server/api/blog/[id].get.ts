import { createError, defineEventHandler, getRouterParam } from "nuxt/server"
import { getPost } from "../../utils/collections"

export default defineEventHandler(async (event) => {
  const post = await getPost(getRouterParam(event, "id") ?? "")
  if (!post) throw createError({ status: 404, statusText: "Post not found" })
  return post
})
