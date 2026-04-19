import { hubKv } from "../../src/vite.ts"

export default {
  serverDir: "server",
  modules: [hubKv().nitro],
}
