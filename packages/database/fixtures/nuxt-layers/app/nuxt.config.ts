// The application has no Database Definition. Its database comes from the layers.
export default defineNuxtConfig({
  extends: ["../layers/accounts", "../layers/blog"],
})
