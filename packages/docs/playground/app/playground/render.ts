import type { DocsRenderFunction } from "@vite-hub/docs/runnable"

const render: DocsRenderFunction = (files, { example }) => {
  const html = files["index.html"]
  if (html === undefined) return { html: "", issues: [{ message: "Create index.html to see a preview." }] }
  const pixel = example.assets?.["pixel.bin"]
  const bytes = pixel ? [...pixel].map(byte => byte.toString(16).padStart(2, "0")).join(" ") : "none"
  const issues = html.includes("<h1>") ? [] : [{ message: "The page has no <h1>.", file: "index.html", line: 1 }]
  return { html: `${html}${files["footer.html"] ?? ""}<p data-asset="pixel.bin">pixel.bin: ${bytes}</p>`, issues }
}

export default render
