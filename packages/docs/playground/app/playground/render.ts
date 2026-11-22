import type { DocsRenderFunction } from "@vite-hub/docs/runnable"

const render: DocsRenderFunction = (files) => {
  const html = files["index.html"]
  if (html === undefined) return { html: "", issues: [{ message: "Create index.html to see a preview." }] }
  return { html }
}

export default render
