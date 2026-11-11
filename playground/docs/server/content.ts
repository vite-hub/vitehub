import { defineContent } from "vite-hub/content"
import cms from "vite-hub/cms"
import { docsCollection } from "vite-hub/docs"

// The Console edits the pages in `content/`. Drafts and publishes go to the Blob + Database store in `.data`, so the
// published site still renders the files. Everyone may edit on this development server and no one in production.
export default defineContent({
  extends: cms,
  collections: { docs: docsCollection() },
  authorize: () => import.meta.dev,
})
