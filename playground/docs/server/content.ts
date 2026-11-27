import { defineContent } from "vite-hub/content"
import cms from "vite-hub/cms"
import { docsCollection } from "vite-hub/docs"

export default defineContent({
  extends: cms,
  collections: { docs: docsCollection() },
  authorize: () => import.meta.dev,
})
