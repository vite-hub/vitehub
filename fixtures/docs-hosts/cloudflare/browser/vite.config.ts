import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({
    host: 'cloudflare',
    browser: true,
  }),
}
