import { hubQueue } from "../../src/vite.ts"

export default {
  modules: [hubQueue().nitro],
  srcDir: "server",
}
