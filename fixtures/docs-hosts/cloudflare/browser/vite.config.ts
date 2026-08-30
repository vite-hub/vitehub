import { vitehub } from 'vite-hub'

export default {
  plugins: vitehub({
    preset: 'cloudflare',
    browser: true,
  }),
}
