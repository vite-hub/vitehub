import type { DummyModuleOptions } from "../types.ts";
import { createDummyMessage } from "../core/message.ts";

export function hubDummyNuxt(options?: DummyModuleOptions) {
  return {
    module: "@vitehub/dummy/nuxt",
    message: createDummyMessage(options),
  };
}
