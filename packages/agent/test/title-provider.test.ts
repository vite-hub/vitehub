import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapters: [] as Array<Record<string, unknown>>,
  generate: vi.fn(async (context: { input?: { prompt?: string }; prompt?: string }) => ({
    text: (context.prompt ?? context.input?.prompt ?? "").includes("Generate a title")
      ? "Inherited provider title"
      : "Main answer",
  })),
}));

vi.mock("../src/provider-agent.ts", () => ({
  createProviderAgentAdapter: (options: Record<string, unknown>) => {
    mocks.adapters.push(options);
    return {
      generate: mocks.generate,
      metadata: async () => ({}),
      name: options.provider,
      stream: mocks.generate,
    };
  },
}));

import { title } from "../src/capabilities.ts";
import { createMessage, defineAgent, runAgent } from "../src/index.ts";

describe("title provider inheritance", () => {
  afterEach(() => {
    mocks.adapters.length = 0;
    mocks.generate.mockClear();
  });

  it.each([
    { expectedModel: "gpt-main", titleOptions: {}, reasoningEffort: "medium" },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap" }, reasoningEffort: undefined },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap", reasoningEffort: "low" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-main", titleOptions: { reasoningEffort: "low" }, reasoningEffort: "medium" },
  ])(
    "reuses the normalized provider configuration with model $expectedModel",
    async ({ expectedModel, titleOptions, reasoningEffort }) => {
      const credentials = vi.fn(() => JSON.stringify({ token: "secret" }));
      const environment = vi.fn(() => ({
        CODEX_HOME: "/agent/codex",
        ...(reasoningEffort === undefined
          ? { T3CODE_CODEX_LAUNCH_ARGS: '-c model_reasoning_effort="high"' }
          : {}),
      }));
      const finish = vi.fn();
      const agent = defineAgent({
        capabilities: [title(titleOptions)],
        driver: {
          credentials,
          env: environment,
          kind: "codex",
          launch: { args: ["codex"], command: "ssh" },
          model: "gpt-main",
          permissions: "allow-all",
          reasoningEffort,
        },
        hooks: { "agent:finish": finish },
      });

      await runAgent(
        agent,
        { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
        {
          messages: [createMessage({ role: "user", text: "Explain item 18807" })],
        },
      );

      const mainDriver = mocks.adapters.find(
        (adapter) => adapter.model === "gpt-main" && adapter.reasoningEffort === reasoningEffort,
      );
      const titleDriver = mocks.adapters.find(
        (adapter) => adapter.model === expectedModel && adapter !== mainDriver,
      );
      expect(mainDriver).toBeDefined();
      expect(titleDriver).toMatchObject({
        credentials,
        env: environment,
        launch: { args: ["codex"], command: "ssh" },
        model: expectedModel,
        permissions: "allow-all",
        provider: "codex",
        reasoningEffort: titleOptions.reasoningEffort ?? reasoningEffort,
      });
      expect(titleDriver?.credentials).toBe(mainDriver?.credentials);
      expect(titleDriver?.env).toBe(mainDriver?.env);
      expect(titleDriver?.launch).toBe(mainDriver?.launch);
      expect(finish.mock.calls[0]![0].extensions.get("title")).toEqual({
        title: "Inherited provider title",
      });
    },
  );
});
