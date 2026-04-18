import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  const pathname = getRouterParam(event, "pathname") || ""
  return await blob.serve(event, pathname)
})
