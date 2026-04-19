import { defineEventHandler } from "h3"
import { blob } from "@vitehub/blob"

export default defineEventHandler(async () => {
  return await blob.put("avatars/user-1.txt", "hello blob", {
    contentType: "text/plain",
  })
})
