import { H3, serve } from "h3"
import { blob } from "@vitehub/blob"

const app = new H3()
  .post("/files", async () => {
    return await blob.put("avatars/user-1.txt", "hello blob", {
      contentType: "text/plain",
    })
  })
  .get("/files/:pathname", async (event) => {
    return await blob.serve(event, event.context.params.pathname)
  })

serve(app)
