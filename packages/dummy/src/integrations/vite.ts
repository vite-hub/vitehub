import type { DummyModuleOptions } from "../types.ts";
import { createDummyMessage } from "../core/message.ts";

export function hubDummyVite(options?: DummyModuleOptions) {
  return {
    name: "vitehub-dummy",
    message: createDummyMessage(options),
  };
}
