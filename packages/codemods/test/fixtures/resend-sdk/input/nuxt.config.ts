export default defineNuxtConfig({
  modules: [],
  runtimeConfig: {
    resendApiKey: process.env.MAIL_KEY,
  },
})
