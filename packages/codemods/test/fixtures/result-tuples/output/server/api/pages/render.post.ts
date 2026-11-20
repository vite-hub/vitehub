import { defineEventHandler } from 'h3'
import { runBrowser as render, runBrowserContent } from 'vite-hub/browser'
import { runSandboxTask } from 'vite-hub/sandbox/task'
import { toResponse as toResponse2 } from 'vite-hub/runtime'

async function loadReport(): Promise<Response> {
  return await runSandboxTask('report')
}

export default defineEventHandler(async (event) => {
  const { url } = await readBody<{ url: string }>(event)
  const toResponse = await loadReport()
  const [htmlError, html] = await runBrowserContent({ url })
  if (htmlError) throw htmlError
  if (!html) {
    const [error, data] = await render('page-html', { url })
    return toResponse2(error ?? data)
  }
  const [error2, data2] = await runSandboxTask('summarize', { html, report: await toResponse.json() })
  return toResponse2(error2 ?? data2)
})
