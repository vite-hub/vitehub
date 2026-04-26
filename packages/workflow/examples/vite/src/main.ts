document.body.innerHTML = `
  <main>
    <h1>ViteHub Workflow</h1>
    <p>This request starts the discovered <code>welcome</code> workflow.</p>
    <pre id="workflow-result">Starting workflow...</pre>
  </main>
`

const result = document.querySelector<HTMLPreElement>("#workflow-result")
const response = await fetch("/api/welcome", {
  body: JSON.stringify({
    email: "ava@example.com",
    marker: "docs",
  }),
  headers: {
    "content-type": "application/json",
  },
  method: "POST",
})

if (result) {
  result.textContent = JSON.stringify(await response.json(), null, 2)
}
