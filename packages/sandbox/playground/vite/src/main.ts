type SandboxResponse = {
  result?: {
    items?: string[]
    summary?: string
  }
}

const app = document.querySelector<HTMLElement>('#app')

if (!app)
  throw new Error('Missing app root.')

app.innerHTML = `
  <section style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 24px;">
    <h1 style="font-size: 2rem; line-height: 1.1; margin: 0 0 12px;">Sandbox Vite Example</h1>
    <p style="margin: 0 0 24px; color: #555;">POST to <code>/api/sandboxes/release-notes</code> to summarize release notes inside an isolated sandbox.</p>

    <form id="sandbox-form" style="display: grid; gap: 12px; margin-bottom: 24px;">
      <label style="display: grid; gap: 6px;">
        <span>Release notes</span>
        <textarea name="notes" rows="6" style="padding: 12px 14px; border: 1px solid #ccc; border-radius: 10px;">- Added weekly digest
- Tightened signup copy
- Fixed failed billing retries</textarea>
      </label>
      <button type="submit" style="padding: 12px 16px; border: 0; border-radius: 10px; background: #111; color: #fff; font-weight: 600;">Run sandbox</button>
    </form>

    <section>
      <h2 style="font-size: 1rem; margin: 0 0 8px;">Sandbox response</h2>
      <pre id="sandbox-output" style="margin: 0; padding: 16px; border-radius: 12px; background: #f6f6f6; overflow: auto;">Waiting for a request.</pre>
    </section>
  </section>
`

const form = document.querySelector<HTMLFormElement>('#sandbox-form')
const output = document.querySelector<HTMLElement>('#sandbox-output')

function renderJson(value: unknown) {
  if (!output)
    return
  output.textContent = JSON.stringify(value, null, 2)
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault()

  const formData = new FormData(form)
  const notes = String(formData.get('notes') || '')

  renderJson({ loading: true })

  const response = await fetch('/api/sandboxes/release-notes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ notes }),
  })

  const body = response.ok
    ? await response.json() as SandboxResponse
    : { status: response.status, statusText: response.statusText, body: await response.text() }

  renderJson(body)
})
