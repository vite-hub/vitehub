import type { DocsRenderFunction } from "@vite-hub/docs/runnable"

// The render module of /docs/try/render. The page calls it in the browser 200 ms after each edit, and shows the HTML
// in the Output tab.
const render: DocsRenderFunction = (files) => {
  const html = files["index.html"]
  if (html === undefined) return { html: "", issues: [{ message: "Create index.html to see a preview." }] }
  return { html }
}

export default render
