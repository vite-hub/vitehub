document.body.innerHTML = `
  <main>
    <h1>ViteHub Queue</h1>
    <p>This request runs the discovered <code>welcome-email</code> queue.</p>
    <pre id="queue-result">Sending queue request...</pre>
  </main>
`

const result = document.querySelector<HTMLPreElement>("#queue-result")
const response = await fetch("/api/welcome", {
  body: JSON.stringify({
    email: "ava@example.com",
    template: "vip",
  }),
  headers: {
    "content-type": "application/json",
  },
  method: "POST",
})

if (result) {
  result.textContent = JSON.stringify(await response.json(), null, 2)
}
