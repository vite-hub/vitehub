import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adapters: [] as Array<Record<string, unknown>>,
  generateText: vi.fn(async () => ({ text: "Requested model title" })),
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

vi.mock("../src/internal/ai-sdk-runtime.ts", () => ({
  loadAiSdk: async () => ({ generateText: mocks.generateText }),
}));

import { resolveRuntimeValue } from "@vite-hub/runtime";
import { codexLaunchArgs } from "../src/internal/codex-launch-args.ts";
import type { AgentProviderEnvironmentResolver } from "../src/types.ts";
import { title } from "../src/capabilities.ts";
import { createMessage, defineAgent, runAgent } from "../src/index.ts";

describe("title provider inheritance", () => {
  it.each(["", " ", "\t\n"])("rejects empty title reasoning effort: %j", (reasoningEffort) => {
    expect(() => title({ reasoningEffort })).toThrow("must be a non-empty model-advertised value");
  });

  afterEach(() => {
    mocks.adapters.length = 0;
    mocks.generate.mockClear();
    mocks.generateText.mockClear();
  });

  it.each([false, true])("honors a non-string title model override (resolver: %s)", async (resolver) => {
    const model = {
      specificationVersion: "v3" as const,
      provider: "test",
      modelId: "title-only",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    };
    const resolveModel = vi.fn(() => model);
    const finish = vi.fn();
    const agent = defineAgent({
      capabilities: [title({ model: resolver ? resolveModel : model })],
      driver: { kind: "codex", model: "gpt-main" },
      hooks: { "agent:finish": finish },
    });
    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain model routing" })],
    });
    expect(finish.mock.calls[0]![0].extensions.get("title")).toEqual({ title: "Requested model title" });
    expect(mocks.generateText).toHaveBeenCalledOnce();
    expect(mocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ modelId: "title-only" }),
    }));
    expect(mocks.adapters).toHaveLength(1);
    if (resolver) expect(resolveModel).toHaveBeenCalled();
  });

  it.each([
    { expectedModel: "gpt-main", titleOptions: {}, reasoningEffort: "medium" },
    { expectedModel: "gpt-main", titleOptions: { instructions: "Use a short subject title" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap" }, reasoningEffort: undefined },
    { expectedModel: "gpt-cheap", titleOptions: { model: "gpt-cheap", reasoningEffort: "low" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-main", titleOptions: { reasoningEffort: "low" }, reasoningEffort: "medium" },
    { expectedModel: "gpt-main", titleOptions: { reasoningEffort: "  low  " }, reasoningEffort: "medium" },
    { expectedModel: "gpt-main", titleOptions: { reasoningEffort: "low" }, reasoningEffort: undefined },
  ])(
    "reuses the normalized provider configuration with model $expectedModel",
    async ({ expectedModel, titleOptions, reasoningEffort }) => {
      const credentials = vi.fn(() => JSON.stringify({ token: "secret" }));
      const environment = vi.fn(() => ({
        CODEX_HOME: "/agent/codex",
        ...(reasoningEffort === undefined
          ? { T3CODE_CODEX_LAUNCH_ARGS: '--sandbox read-only -c model_reasoning_effort="high"' }
          : {}),
      }));
      const finish = vi.fn();
      const agent = defineAgent({
        capabilities: [title(titleOptions)],
        driver: {
          credentials,
          credentialProfile: "primary-profile",
          instructions: "Primary agent policy",
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
        launch: { args: ["codex"], command: "ssh" },
        model: expectedModel,
        permissions: "allow-all",
        provider: "codex",
        reasoningEffort: titleOptions.reasoningEffort === undefined ? reasoningEffort : undefined,
      });
      expect(titleDriver?.instructions).toBe(titleOptions.instructions);
      expect(titleDriver?.credentialProfile).toBeUndefined();
      expect(mainDriver?.instructions).toBe("Primary agent policy");
      expect(mainDriver?.credentialProfile).toBe("primary-profile");
      expect(titleDriver?.credentials).toBe(mainDriver?.credentials);
      expect(mainDriver?.env).toBe(environment);
      if (titleOptions.reasoningEffort === undefined) {
        expect(titleDriver?.env).toBe(mainDriver?.env);
      } else {
        const resolverContext = finish.mock.calls[0]![0];
        const resolved = await resolveRuntimeValue(titleDriver?.env as AgentProviderEnvironmentResolver, resolverContext);
        expect(resolved).toEqual({
          ...environment(),
          T3CODE_CODEX_LAUNCH_ARGS: [environment().T3CODE_CODEX_LAUNCH_ARGS, codexLaunchArgs({ reasoningEffort: "low" })].filter(Boolean).join(" "),
        });
        expect(environment).toHaveBeenCalledWith(resolverContext);
        expect(environment().T3CODE_CODEX_LAUNCH_ARGS).toBe(reasoningEffort === undefined ? '--sandbox read-only -c model_reasoning_effort="high"' : undefined);
      }
      expect(titleDriver?.launch).toBe(mainDriver?.launch);
      expect(finish.mock.calls[0]![0].extensions.get("title")).toEqual({
        title: "Inherited provider title",
      });
    },
  );
});
