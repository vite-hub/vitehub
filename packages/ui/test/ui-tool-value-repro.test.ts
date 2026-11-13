// @vitest-environment happy-dom
import type { UIMessage } from "ai";
import { mount } from "@vue/test-utils";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { MessageParts } from "../src/components/message-parts.ts";

function toolText(output: unknown): string {
  const part = { input: {}, output, state: "output-available", toolCallId: "call", type: "tool-shell" } as UIMessage["parts"][number];
  return mount(MessageParts, { props: { parts: [part] } }).text();
}

describe("ui tool value repro", () => {
  it.each([
    ["cyclic", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })(), '"self": "[Circular]"'],
    ["bigint", { count: 1n }, '"count": "1n"'],
    ["throwing toJSON", { toJSON() { throw new Error("cannot serialize"); } }, "[Value cannot be shown]"],
    ["cross-realm throwing toJSON", vm.runInNewContext("({ toJSON() { throw new Error('cross realm failure'); } })"), "[Value cannot be shown]"],
  ])("renders %s tool values without crashing", (_name, output, expected) => {
    expect(toolText(output)).toContain(expected);
  });
});
