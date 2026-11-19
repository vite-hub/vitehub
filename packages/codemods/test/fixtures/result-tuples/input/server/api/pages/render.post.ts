import { runBrowserContent } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const { url } = await readBody<{ url: string }>(event)
  const html = await runBrowserContent({ url })
  if (!html) return runBrowser('page-html', { url })
  return await runSandboxTask('summarize', { html })
})
