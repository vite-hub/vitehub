import type { DummyModuleOptions } from "../types.ts";
import { resolveDummyModuleOptions } from "./options.ts";

export function createDummyMessage(options: DummyModuleOptions = {}): string {
  const resolved = resolveDummyModuleOptions(options);

  return resolved.enabled
    ? `dummy package ready for ${resolved.label}`
    : `dummy package disabled for ${resolved.label}`;
}
