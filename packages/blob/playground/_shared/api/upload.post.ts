import { defineEventHandler } from "h3"
import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  return await blob.handleUpload(event, {
    formKey: "files",
    multiple: true,
  })
})
