import { defineEventHandler, getQuery } from "nuxt/server"
import { listReleases } from "../../utils/collections"

export default defineEventHandler(event => listReleases(Math.min(Number(getQuery(event).limit) || 50, 50)))
