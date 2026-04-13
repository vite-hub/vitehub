import type {
  DummyModuleOptions,
  ResolvedDummyModuleOptions,
} from "../types.ts";

export function resolveDummyModuleOptions(
  options: DummyModuleOptions = {},
): ResolvedDummyModuleOptions {
  return {
    label: options.label?.trim() || "vitehub",
    enabled: options.enabled ?? true,
  };
}
