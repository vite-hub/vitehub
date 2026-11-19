import { runBrowserContent } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const { url } = await readBody<{ url: string }>(event)
  const [htmlError, html] = await runBrowserContent({ url })
  if (htmlError) throw htmlError
  if (!html) return runBrowser('page-html', { url })
  const [error, data] = await runSandboxTask('summarize', { html })
  if (error) throw error
  return data
})
