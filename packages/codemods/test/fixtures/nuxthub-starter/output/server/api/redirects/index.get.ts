import { kv } from 'vite-hub/kv'

export default eventHandler(async () => {
  return (await kv.get('redirects') || {})
})
