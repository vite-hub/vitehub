import { defineEventHandler } from 'h3'
import { runBrowser as render, runBrowserContent } from 'vite-hub/browser'
import { runSandboxTask } from 'vite-hub/sandbox/task'

async function loadReport(): Promise<Response> {
  return await runSandboxTask('report')
}

export default defineEventHandler(async (event) => {
  const { url } = await readBody<{ url: string }>(event)
  const toResponse = await loadReport()
  const html = await runBrowserContent({ url })
  if (!html) {
    return render('page-html', { url })
  }
  return await runSandboxTask('summarize', { html, report: await toResponse.json() })
})
