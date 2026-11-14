import { runInNewContext } from "node:vm";
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server";
import { expect, it } from "vitest";
import { installConsoleInvocationFallback, resolveConsoleInvocations } from "../src/console/internal.ts";
import { getLogSource, installLogSource } from "../src/logs/host.ts";
import { createLogBuffer } from "../src/logs/memory.ts";

function inRealm<T>(realm: unknown, run: () => T): T {
  const host = globalThis;
  const descriptor = Object.getOwnPropertyDescriptor(host, "globalThis");
  if (!descriptor) throw new Error("Missing globalThis descriptor");
  Object.defineProperty(host, "globalThis", { ...descriptor, value: realm });
  try {
    return run();
  } finally {
    Object.defineProperty(host, "globalThis", descriptor);
  }
}

it("installs Logs for another project without rebinding Console invocations", () => {
  const realm: unknown = runInNewContext("globalThis", { process: {} });
  const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() });
  const source = createLogBuffer().source;
  const resolved = inRealm(realm, () => {
    installConsoleInvocationFallback(invocations, "/first");
    installLogSource("/second", source);
    return { invocations: resolveConsoleInvocations(), logs: getLogSource() };
  });
  expect(resolved.invocations).toBe(invocations);
  expect(resolved.logs).toBe(source);
});

it("serves the Log source that the host installed last", () => {
  const first = createLogBuffer({ id: "first" }).source;
  const second = createLogBuffer({ id: "second" }).source;
  try {
    installLogSource("/project", first);
    expect(getLogSource()).toBe(first);
    installLogSource("/project", second);
    expect(getLogSource()).toBe(second);
  } finally {
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.logs.source"));
  }
});
