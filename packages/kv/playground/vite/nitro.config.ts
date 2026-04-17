import { hubKv } from "../../src/vite.ts"

export default {
  srcDir: "server",
  modules: [hubKv().nitro],
}
