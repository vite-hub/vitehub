import { createConsoleProjectRegistry } from "../console/project-registry.ts";
import { consoleProjectRootKey } from "../console/internal.ts";
import type { LogSource } from "./source.ts";

const registry = createConsoleProjectRegistry<LogSource>({
  root: consoleProjectRootKey,
  value: Symbol.for("vitehub.logs.source"),
  registry: Symbol.for("vitehub.logs.sources"),
});

/** The host connects a source. It remains the owner of capture and provider setup. */
export function installLogSource(projectRoot: string, source: LogSource): void {
  registry.install(projectRoot, source, globalThis);
}

export function getLogSource(): LogSource | undefined {
  return registry.resolve(globalThis);
}
