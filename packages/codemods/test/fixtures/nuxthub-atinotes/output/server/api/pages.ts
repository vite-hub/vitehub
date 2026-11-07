import { kv } from 'vite-hub/kv'

export default eventHandler(async () => {
  return kv.keys()
})
