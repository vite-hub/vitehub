import { defineEventHandler, getQuery } from "nuxt/server"
import { listPosts } from "../../utils/collections"

export default defineEventHandler(event => listPosts(Math.min(Number(getQuery(event).limit) || 50, 50)))
