// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { AgentInvocationInspector } from "../../src/console/runtime/components/invocation/agent-invocation.ts";
import { channelIcon } from "../../src/console/runtime/components/invocation/internal/channel-icon.ts";
import { invocationBrand, invocationModelMaker, invocationModelName } from "../../src/console/runtime/components/invocation/internal/invocation-brand.ts";
import { invocation } from "./fixtures.ts";

const icon = (origin: string) => mount({ render: () => channelIcon(origin) });

describe("Brand marks", () => {
  it.each(["ticketing", "constructor", "<custom-channel>"])("renders %s with a neutral Channel mark and its own label", (origin) => {
    const wrapper = icon(origin);
    expect(wrapper.attributes("aria-label")).toBe(origin);
    expect(wrapper.attributes("title")).toBe(origin);
    expect(wrapper.get("svg path").attributes("d")).toBeTruthy();
    expect(wrapper.get("svg").html()).toBe(icon("application-channel").get("svg").html());
    expect(wrapper.get("svg").html()).not.toBe(icon("web-chat").get("svg").html());
    expect(wrapper.find("custom-channel").exists()).toBe(false);
    expect(icon("web-chat").attributes("aria-label")).toBe("Web chat");
  });

  it.each([
    ["github-pull-request", "GitHub", "github"],
    ["github-pull-request-comment", "GitHub", "github"],
    ["msteams", "Microsoft Teams", "msteams"],
  ])("renders the %s channel with the %s mark", (origin, label, mark) => {
    expect(icon(origin).attributes("aria-label")).toBe(label);
    expect(icon(origin).get("svg").html()).toBe(icon(mark).get("svg").html());
  });

  it.each([
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"],
    ["anthropic/claude-3-5-sonnet", "Claude 3.5 Sonnet"],
    ["gpt-6-luna", "GPT 6 Luna"],
    ["gpt-5.6", "GPT 5.6"],
    ["llama-3-1-70b", "Llama 3.1 70B"],
    ["gpt-4-1106-preview", "GPT 4 1106 Preview"],
  ])("names the model %s as %s", (id, name) => {
    expect(invocationModelName(id)).toBe(name);
  });

  it("recognizes model makers and providers", () => {
    expect(invocationModelMaker("anthropic/claude-sonnet-4.5")).toMatchObject({ id: "anthropic", label: "Anthropic" });
    expect(invocationModelMaker("gpt-5.6")).toMatchObject({ id: "openai" });
    expect(invocationModelMaker("gemini-2.5-pro")).toMatchObject({ id: "google" });
    expect(invocationModelMaker("x-ai/grok-4")).toMatchObject({ id: "xai", label: "xAI" });
    expect(invocationModelMaker("my-model")).toBeUndefined();
    expect(invocationBrand("openrouter")).toMatchObject({ id: "openrouter", label: "OpenRouter" });
    expect(invocationBrand("anthropic.messages")).toMatchObject({ id: "anthropic" });
    expect(invocationBrand("z-ai")).toMatchObject({ id: "zai", label: "Z.AI" });
    expect(invocationBrand("codex")).toMatchObject({ id: "codex", label: "Codex" });
    expect(invocationBrand("acme-ai")).toEqual({ id: "fallback", label: "Acme AI" });
  });

  it("shows the model maker and a different provider in the setup", () => {
    const wrapper = mount(AgentInvocationInspector, { props: { invocation: invocation([], {
      configuration: { driver: { kind: "model", model: { id: "anthropic/claude-sonnet-4.5", provider: "openrouter" } } },
    }) } });
    expect(wrapper.get(".vh-invocation-execution__model-icon").attributes("data-brand")).toBe("anthropic");
    expect(wrapper.get(".vh-invocation-execution__provider").text()).toBe("OpenRouter");
    expect(wrapper.get(".vh-invocation-execution__provider-icon").attributes("data-brand")).toBe("openrouter");
  });

  it.each(["gpt-5.6", "openai/gpt-5"])("keeps the provider unknown for %s when no provider was recorded", (id) => {
    const wrapper = mount(AgentInvocationInspector, { props: { invocation: invocation([], { configuration: { driver: { model: { id } } } }) } });
    expect(wrapper.get(".vh-invocation-execution__model-icon").attributes("data-brand")).toBe("openai");
    expect(wrapper.find(".vh-invocation-execution__provider").exists()).toBe(false);
  });
});
