import type { DummyModuleOptions } from "../types.ts";
import { createDummyMessage } from "../core/message.ts";

export function hubDummyNitro(options?: DummyModuleOptions) {
  return {
    module: "@vitehub/dummy/nitro",
    message: createDummyMessage(options),
  };
}
