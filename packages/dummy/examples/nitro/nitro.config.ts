import { defineNitroConfig } from "nitro/config";
import { hubDummyNitro } from "@vitehub/dummy/nitro";

export default defineNitroConfig({
  runtimeConfig: {
    dummy: hubDummyNitro(),
  },
});
