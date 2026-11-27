// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ToolList } from "@vite-hub/ui";
import { AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { AgentCapabilityInspector } from "../../src/console/runtime/components/invocation/agent-capability-inspector.ts";
import { invocationTimeline } from "../../src/console/runtime/components/invocation/agent-invocation-timeline.ts";
import type { AgentInvocationView } from "../../src/console/runtime/components/invocation/types.ts";
import { clipboard, delivery, event, invocation, message, runSummary, setupGroup, timestamp, tool } from "./fixtures.ts";

const later = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
const inspect = (value: AgentInvocationView, props: Record<string, unknown> = {}) => mount(AgentInvocationInspector, { props: { invocation: value, ...props } });

/** A meal-logging run with a configured Agent, two tool calls and two deliveries. */
function mealLog(): AgentInvocationView {
  return invocation([
    event("vitehub.agent.configured", { "vitehub.agent.configuration": { agent: { name: "meal-logger" }, capabilities: [{ id: "db" }, { id: "transcribe" }], tools: [{ name: "db_query" }] } }),
    message("user", "Two eggs and toast.", { "message.id": "prompt" }),
    tool("finish", "lookup", "db_query", {}, { timestamp: later(4) }),
    tool("finish", "total", "db_query", {}, { timestamp: later(8) }),
    delivery({ "channel.effect.content": "Working on it.", "channel.effect.kind": "status" }, { timestamp: later(9) }),
    delivery({ "channel.effect.content": "Logged breakfast: **412 kcal**.", "channel.effect.kind": "reply" }, { timestamp: later(18) }),
  ], {
    annotations: { triggeredBy: "Ada" },
    completedAt: later(19),
    configuration: {
      agent: { name: "meal-logger" },
      capabilities: [{ id: "db" }],
      driver: { kind: "model", model: { id: "anthropic/claude-sonnet-4.5", provider: "openrouter" } },
      runtime: { name: "node" },
      tools: [{ capabilityId: "db", label: "Queried database", name: "db_query" }, { capabilityId: "db", name: "db_exec" }],
    },
    id: "meal-log",
    startedAt: timestamp,
    updatedAt: later(19),
  });
}

describe("Agent Invocation inspector", () => {
  describe("status and run summary", () => {
    it.each(["unknown", "constructor", "toString", "__proto__"])("renders persisted status %s as Unknown", (value) => {
      expect(inspect(invocation([], { status: value as AgentInvocationView["status"] })).get('[role="status"].vh-invocation-inspector__status').text()).toContain("Unknown");
    });

    it("summarizes messages, steps, tool calls, and total time", () => {
      expect(runSummary(inspect(mealLog()))).toMatchObject({ Messages: "2", "Tool calls": "2", "Total time": "19s" });
    });

    it("does not label a historical response breakdown as invocation usage", () => {
      const summary = runSummary(inspect(invocation([], { usage: { totalTokens: 59222, inputTokens: 21267, outputTokens: 118, cachedInputTokens: 20352, cacheWriteTokens: 100 } })));
      expect(summary.Tokens).toBe("59,222");
      for (const label of ["Input", "Output", "Cached", "Cache writes"]) expect(summary).not.toHaveProperty([label]);
    });

    it.each([true, false])("preserves cache writes and the cost estimate qualifier (%s)", (estimated) => {
      const wrapper = inspect(invocation([], { usage: {
        totalTokens: 1200, inputTokens: 1100, outputTokens: 100, cacheWriteTokens: 1024,
        cost: { display: "$0.01", estimated, source: estimated ? "pricing" : "provider" },
      } }));
      expect(runSummary(wrapper)).toMatchObject({ "Cache writes": "1,024", [estimated ? "Estimated cost" : "Cost"]: "$0.01" });
      expect(wrapper.get(".vh-invocation-inspector__usage .vh-invocation-inspector__metrics > div").attributes("title"))
        .toBe(estimated ? "Estimated from pricing" : "Reported by the provider");
    });

    it("preserves terminal usage and capability visibility in details", () => {
      const value = invocation([], {
        usage: { totalTokens: 1234, cost: { display: "~$0.02", estimated: true } },
        configuration: { capabilities: [{ id: "files" }], tools: [{ capabilityId: "files", name: "read_file" }] },
      });
      const wrapper = inspect(value);
      expect(runSummary(wrapper)).toMatchObject({ Tokens: "1,234", "Estimated cost": "~$0.02" });
      expect(wrapper.text()).not.toContain("(estimated)");
      expect(wrapper.text()).not.toContain("Capabilities");
      expect(setupGroup(wrapper, "Tools")?.text()).toContain("read_file");
      expect(inspect(value, { showCapabilities: true }).text()).toContain("Capabilities");
    });
  });

  it("shows an imported coding agent session in plain words", () => {
    const invocation: AgentInvocationView = {
      id: "imported", status: "completed", traceId: "trace", createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:05:00Z", observations: [],
      usage: { totalTokens: 1200, inputTokens: 1100, outputTokens: 100, reasoningTokens: 0, cost: { usd: "0.086012", estimated: true, source: "models.dev" } },
      configuration: {
        driver: { kind: "codex", provider: "codex", model: { id: "gpt-6-luna", provider: "codex" } },
        runtime: { name: "import" },
        skills: [{ name: "imagegen", description: "Make images.", source: "codex-system" }, { name: "openai-docs" }],
        mcpServers: [{ name: "nuxt", status: "connected" }],
      },
    };
    const wrapper = mount(AgentInvocationInspector, { props: { invocation } });
    const usage = wrapper.get(".vh-invocation-inspector__usage");
    expect(usage.text()).toContain("Estimated cost$0.086");
    expect(usage.text()).not.toContain("Reasoning");
    expect(usage.get(".vh-invocation-inspector__metrics > div").attributes("title")).toBe("$0.086012, Estimated from models.dev");

    const setup = wrapper.get(".vh-invocation-execution");
    expect(setup.findAll("dt").map(label => label.text())).toEqual(["Model", "Provider", "Runtime"]);
    expect(setup.text()).toContain("GPT 6 Luna");
    expect(setup.text()).toContain("Codex");
    expect(setup.text()).toContain("Imported session");
    expect(setup.text()).not.toContain("import ");

    const chips = wrapper.findAll(".vh-invocation-inspector__chips > li");
    expect(chips.map(chip => chip.text())).toEqual(["imagegen", "openai-docs", "nuxt, connected"]);
    expect(chips[0]!.attributes("title")).toBe("Make images.\nSource: codex-system");
    expect(chips[2]!.get(".vh-invocation-inspector__dot").attributes("data-status")).toBe("connected");
  });

  describe("captured setup", () => {
    const definition = (): AgentInvocationView => invocation([
      event("execute_tool.start", { "tool.id": "call-1", "tool.name": "exec" }, { timestamp: "2026-08-24T00:00:00.100Z" }),
      event("execute_tool.finish", { "tool.id": "call-1", "tool.name": "exec" }, { timestamp: "2026-08-24T00:00:00.200Z" }),
    ], {
      configuration: {
        agent: { name: "babysitter", version: "2" },
        capabilities: [{ id: "github" }],
        channels: [{ id: "reviews", kind: "github" }],
        driver: { kind: "provider", model: { id: "gpt-5.6-sol", provider: "openai" } },
        instructions: ["Follow repository instructions."],
        runtime: { name: "node" },
        tools: [
          { description: "Run a shell command.", inputSchema: { properties: { command: { type: "string" } }, required: ["command"], type: "object" }, name: "exec" },
          { description: "Search the workspace.", name: "search" },
        ],
        workspace: { mode: "write", name: "babysitter", sources: [{ id: "vitehub", repository: "vite-hub/vitehub" }] },
      },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:01.000Z",
      usage: { totalTokens: 1200, inputTokens: 1100, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 },
    });

    it("groups recorded Agent Definition details as captured setup", () => {
      const wrapper = inspect(definition());
      const summary = runSummary(wrapper);
      expect(summary).toMatchObject({ Tokens: "1,200", Input: "1,100", Output: "100" });
      for (const label of ["Cached input", "Cache writes", "Cost"]) expect(summary).not.toHaveProperty([label]);
      expect(summary).not.toHaveProperty("Reasoning");

      const model = wrapper.get(".vh-invocation-execution");
      expect(model.text()).toContain("GPT 5.6 Sol");
      expect(model.get(".vh-invocation-execution__model-icon").attributes("data-brand")).toBe("openai");
      expect(model.get(".vh-invocation-execution__model").attributes("title")).toBe("gpt-5.6-sol by OpenAI");
      expect(model.find(".vh-invocation-execution__provider").exists()).toBe(false);
      expect(model.text()).toContain("node");
      expect(model.find(".vh-invocation-execution__model-icon path").exists()).toBe(true);
      expect(wrapper.find(".vh-invocation-execution__workspace").exists()).toBe(false);
      expect(wrapper.get(".vh-invocation-inspector__agent").text()).toContain("v2");
      expect(wrapper.findAll(".vh-invocation-inspector__content > section h4").map(node => node.text())).toContain("Agent setup");
      expect(setupGroup(wrapper, "Channels")?.text()).toContain("reviews");
      expect(setupGroup(wrapper, "Channels")?.find("svg").exists()).toBe(true);
      expect(wrapper.text()).toContain("Instructions");

      const source = setupGroup(wrapper, "Sources")!.get('a[href="https://github.com/vite-hub/vitehub"]');
      expect(source.text()).toBe("vitehub");
      expect(source.get(".vh-channel-icon").attributes("aria-label")).toBe("GitHub");

      const tools = setupGroup(wrapper, "Tools")!;
      expect(tools.text()).toContain("1 of 2 used");
      expect(tools.get(".vh-agent-tool-list__disclosure").text()).toContain("Run a shell command.");
      expect(tools.get(".vh-agent-tool-list__schema").text()).toContain("command");
      expect(tools.findAll(".vh-agent-tool-list > *").map(item => item.attributes("data-used"))).toEqual(["true", "false"]);
    });

    it("names a namespaced model by its maker and hides a missing provider", () => {
      const value = definition();
      const wrapper = inspect({ ...value, configuration: { ...value.configuration, driver: { kind: "provider", model: { id: "openai/gpt-5" } } } });
      expect(wrapper.get(".vh-invocation-execution").text()).toContain("GPT 5");
      expect(wrapper.get(".vh-invocation-execution__model-icon").attributes("data-brand")).toBe("openai");
      expect(wrapper.find(".vh-invocation-execution__provider").exists()).toBe(false);
    });

    it("hides status and timeline on request and discloses shortened setup", () => {
      const value = definition();
      const compact = inspect(value, { showStatus: false, showTimeline: false });
      expect(compact.find(".vh-invocation-inspector__status").exists()).toBe(false);
      expect(compact.find(".vh-invocation-timeline").exists()).toBe(false);
      expect(compact.text()).toContain("Agent setup");
      const shortened = inspect({ ...value, configuration: { ...value.configuration, runtime: { name: "unknown" }, truncated: true } });
      expect(shortened.get('[role="note"]').text()).toContain("Some setup values were shortened");
      expect(shortened.get(".vh-invocation-execution").text()).not.toContain("unknown");
    });

    it("groups recorded tools under their capability without inventing ownership", () => {
      const wrapper = inspect(invocation([], { configuration: { capabilities: [{ id: "files" }], tools: [{ name: "read", capabilityId: "files", description: "Read exact bytes." }, { name: "native", description: "Provider tool." }] } }), { showCapabilities: true });
      const capability = wrapper.findAll("details").find(item => item.find("summary").text().startsWith("files"))!;
      expect(capability.text()).toContain("Read exact bytes.");
      expect(capability.text()).not.toContain("Provider tool.");
      expect(wrapper.text()).toContain("Provider tool.");
    });

    it("uses channel marks for configured invocation channels", () => {
      const wrapper = inspect(invocation([], { configuration: { channels: [{ id: "support", kind: "msteams" }, { id: "records", kind: "airtable" }] } }));
      expect(setupGroup(wrapper, "Channels")!.findAll(".vh-channel-icon").map(icon => icon.attributes("aria-label"))).toEqual(["Microsoft Teams", "airtable"]);
    });

    it("renders historical tool catalogs that contain journal truncation markers", () => {
      const wrapper = inspect(invocation([], { configuration: JSON.parse('{"tools":[{"name":"search"},"[truncated]",{},null,{"name":"exec"}]}'), status: "failed" }));
      expect(wrapper.text()).toContain("search");
      expect(wrapper.text()).toContain("exec");
      expect(wrapper.get('[role="note"]').text()).toContain("Some setup values were shortened");
    });

    it.each([
      ["ignores malformed persisted channel entries", [null, { id: "support", kind: "web-chat" }, { id: "invalid", kind: 42 }, "[truncated]"], ["support"]],
      ["marks a malformed persisted channel catalog as shortened", "[truncated]", []],
    ])("%s", (_label, channels, shown) => {
      const wrapper = inspect(invocation([], { configuration: { channels } as never }));
      expect(wrapper.text()).toContain("Some setup values were shortened");
      expect(wrapper.findAll(".vh-invocation-inspector__badge").map(badge => badge.text())).toEqual(shown);
    });

    it("renders structured workspace sources alongside historical source strings", () => {
      const value = invocation([], { configuration: { workspace: { sources: [{ id: "docs", repository: "vite-hub/vitehub" }, { id: "local" }, "github:legacy/repo"] } } });
      const sources = setupGroup(inspect(value), "Sources")!;
      expect(sources.findAll(".vh-invocation-inspector__badge").map(badge => badge.text())).toEqual(["docs", "local", "github:legacy/repo"]);
      expect(sources.findAll("a").map(link => link.attributes("href"))).toEqual(["https://github.com/vite-hub/vitehub", "https://github.com/legacy/repo"]);
      expect(sources.findAll("a")[0]?.attributes("title")).toBe("docs: vite-hub/vitehub");
      expect(setupGroup(inspect(value, { showSources: false }), "Sources")).toBeUndefined();
    });
  });

  describe("tools and timeline", () => {
    it("jumps from a used tool to its first call", async () => {
      const inspector = inspect(mealLog(), { showCapabilities: true });
      const used = inspector.get('.vh-agent-tool-list [data-used="true"]');
      expect(used.get("small").text()).toBe("Queried database");
      await used.get("button.vh-agent-tool-list__count").trigger("click");
      expect(inspector.emitted("selectActivity")).toEqual([["lookup"]]);
      expect(inspector.get('.vh-agent-tool-list [data-used="false"] .vh-agent-tool-list__count').element.tagName).toBe("SPAN");

      const capabilities = mount(AgentCapabilityInspector, { props: { invocation: mealLog() } });
      await capabilities.get("button.vh-agent-tool-list__count").trigger("click");
      expect(capabilities.emitted("selectActivity")).toEqual([["lookup"]]);

      const readOnly = mount(ToolList, { props: { calls: { db_query: 2 }, tools: [{ name: "db_query" }] } });
      expect(readOnly.find("button").exists()).toBe(false);
      expect(readOnly.get(".vh-agent-tool-list__count").text()).toBe("2 calls");
    });

    it("keeps rounded and terminal trace timings inside their bounds", () => {
      const value = invocation([tool("finish", "terminal", "finish", { "tool.durationMs": 1_000 }, { timestamp: "2026-08-22T00:01:59.999Z" })], {
        completedAt: "2026-08-22T00:01:59.999Z", startedAt: timestamp, updatedAt: "2026-08-22T00:01:59.999Z",
      });
      expect(inspect(value).get(".vh-invocation-timeline__row").text()).toContain("+1m 59s · 1s");
      expect(invocationTimeline(value)).toMatchObject([{ durationMs: 1_000, offsetMs: 118_999 }]);
    });
  });

  describe("identifiers", () => {
    it("copies identifiers without displaying their full values", async () => {
      const writeText = vi.fn(async () => {});
      clipboard(writeText);
      const value = invocation([], { id: "sha256_invocation_identifier", traceId: "sha256_trace_identifier" });
      const wrapper = inspect(value);
      expect(wrapper.text()).not.toContain(value.id);
      expect(wrapper.text()).not.toContain(value.traceId);
      const copy = wrapper.get('button[aria-label="Copy Trace ID"]');
      await copy.trigger("click");
      await flushPromises();
      expect(writeText).toHaveBeenCalledWith(value.traceId);
      expect(copy.attributes("aria-label")).toBe("Trace ID copied");
      expect(copy.find(".vh-invocation-inspector__copy-icon").exists()).toBe(true);
      expect(wrapper.get('[role="status"]').text()).toBe("Trace ID copied");
      wrapper.unmount();
    });

    it("announces clipboard failures without an unhandled rejection", async () => {
      clipboard(vi.fn(async () => { throw new Error("Clipboard denied"); }));
      const wrapper = inspect(invocation());
      await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[role="status"]').text()).toBe("Trace ID could not be copied");
      expect(wrapper.get('button[aria-label="Copy Trace ID"]').find(".vh-invocation-inspector__copy-icon").exists()).toBe(true);

      const status = wrapper.get('[role="status"]');
      await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
      expect(status.text()).toBe("");
      await flushPromises();
      expect(status.text()).toBe("Trace ID could not be copied");
    });

    it("announces when the Clipboard API is unavailable", async () => {
      clipboard(undefined);
      const wrapper = inspect(invocation());
      await wrapper.get('button[aria-label="Copy Trace ID"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[role="status"]').text()).toBe("Trace ID could not be copied");
    });
  });

  describe("run errors", () => {
    const failed = (error: NonNullable<AgentInvocationView["error"]>) => invocation([], { error, failedAt: later(5), startedAt: timestamp, status: "failed", updatedAt: later(5) });

    it("surfaces the terminal error beside the exact status", () => {
      const value = failed({ message: "The provider stopped before returning a result.", name: "Provider error" });
      const wrapper = inspect(value);
      expect(wrapper.get(".vh-invocation-inspector__status").text()).toContain("Failed");
      expect(wrapper.get(".vh-invocation-error__title").text()).toBe("Run failed");
      expect(wrapper.get(".vh-invocation-error__code").text()).toBe("Provider error");
      expect(wrapper.get(".vh-invocation-error__message").text()).toBe("The provider stopped before returning a result.");
      const secondary = inspect(value, { showError: false });
      expect(secondary.text()).toContain("Failed");
      expect(secondary.find(".vh-invocation-error").exists()).toBe(false);
    });

    it.each([
      ["https://vitehub.dev/docs/agents/limits-and-errors#AGENT_R0726", true],
      ["javascript:alert(document.domain)", false],
      ["java\nscript:alert(document.domain)", false],
      ["data:text/html,<script>alert(1)</script>", false],
      ["http://vitehub.dev/docs/agents/limits-and-errors", false],
      ["//vitehub.dev/docs/agents/limits-and-errors", false],
      ["/docs/agents/limits-and-errors", false],
      ["https://", false],
      ["https://[invalid", false],
    ])("validates failed-run documentation links while retaining the diagnostic: %s", async (docs, allowed) => {
      const error = { code: "AGENT_R0726", docs, message: "Workspace spend cap reached" };
      const wrapper = inspect(invocation([], { error, status: "failed" }));
      const link = wrapper.find(".vh-invocation-error__actions a");
      expect(link.exists()).toBe(allowed);
      if (allowed) {
        expect(link.attributes("href")).toBe(docs);
        expect(link.text()).toBe("Read the docs");
      }
      await wrapper.get(".vh-invocation-error__action[aria-controls]").trigger("click");
      const diagnostic = wrapper.get(".vh-invocation-error__details").text();
      expect(JSON.parse(diagnostic)).toMatchObject(error);

      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      try {
        await wrapper.get("button.vh-invocation-error__action:not([aria-controls])").trigger("click");
        expect(writeText).toHaveBeenCalledWith(diagnostic);
      } finally {
        vi.unstubAllGlobals();
        wrapper.unmount();
      }
    });

    it("renders provider-owned recovery instructions without guessing advice", () => {
      const error = { code: "AGENT_R0726", message: "Workspace spend cap reached" };
      const wrapper = inspect(invocation([], { error, status: "failed" }));
      expect(wrapper.find(".vh-invocation-error__fix").exists()).toBe(false);
      expect(wrapper.get(".vh-invocation-error__details").text()).toContain("Workspace spend cap reached");
      expect(inspect(invocation([], { error: { ...error, fix: "Contact the workspace owner." }, status: "failed" })).get(".vh-invocation-error__fix").text()).toContain("Contact the workspace owner.");
    });

    it("keeps bounded runtime diagnostics available behind a disclosure", async () => {
      const wrapper = inspect(failed({
        cause: { message: "The upstream socket closed.", name: "SocketError" },
        code: "provider_unavailable",
        message: "The provider stopped before returning a result.",
        name: "Provider error",
        requestId: "request-123",
        statusCode: 503,
      }));
      const toggle = wrapper.get(".vh-invocation-error__action[aria-controls]");
      const details = wrapper.get(".vh-invocation-error__details");
      expect(toggle.text()).toBe("Details");
      expect(toggle.attributes("aria-expanded")).toBe("false");
      expect(toggle.attributes("aria-controls")).toBe(details.attributes("id"));
      expect(details.attributes("hidden")).toBeDefined();
      await toggle.trigger("click");
      expect(toggle.attributes("aria-expanded")).toBe("true");
      expect(wrapper.get(".vh-invocation-error__details").attributes("hidden")).toBeUndefined();
      expect(details.text()).toContain('"code": "provider_unavailable"');
      expect(details.text()).toContain('"requestId": "request-123"');
      expect(details.text()).toContain("The upstream socket closed.");
    });
  });
});
