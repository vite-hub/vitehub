import { H3 } from "h3"

import { handleImageUpload } from "./image-upload"

const app = new H3()

app.post("/api/images", handleImageUpload)

export default app
