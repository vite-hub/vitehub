// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineConnect } from "@vite-hub/web-container/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectPanel, useConnectStore } from "../src/workspace.ts";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectPanel", () => {
  it.each(["getItem", "setItem", "removeItem"] as const)("keeps credentials in memory when %s throws", (method) => {
    const blocked = {
      length: 0,
      clear() {},
      key: () => null,
      getItem: () => null,
      setItem() {},
      removeItem() {},
    };
    blocked[method] = () => { throw new Error("Storage blocked"); };
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(blocked);
    const store = useConnectStore();
    store.set("openai", "sk-memory");
    expect(store.credentials.value).toEqual({ openai: "sk-memory" });
    store.remove("openai");
    expect(store.credentials.value).toEqual({});
    store.clear();
    vi.restoreAllMocks();
  });

  it.each([{ vercel: { clientId: "client" } }, { github: { app: "my-app" } }])("emits OAuth metadata for %j", async (config) => {
    const connect = defineConnect(config);
    const provider = connect.providers[0]!;
    const wrapper = mount(ConnectPanel, { props: { connect } });
    await wrapper.get(`[aria-label='Connect ${provider.name === "github" ? "GitHub" : "Vercel"}']`).trigger("click");
    expect(wrapper.emitted("oauth")).toEqual([[provider]]);
    expect(wrapper.find("input[type=password]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Paste a token");
    await wrapper.setProps({ states: { [provider.name]: { status: "error" } } });
    expect(wrapper.text()).toContain("Sign in again");
    await wrapper.get(`[aria-label='Connect ${provider.name === "github" ? "GitHub" : "Vercel"}']`).trigger("click");
    expect(wrapper.emitted("oauth")).toEqual([[provider], [provider]]);
    wrapper.unmount();
  });

  const connect = defineConnect({ anthropic: true, cloudflare: { relay: "reader" }, github: true, openai: true, vercel: true });

  it("groups providers and shows one status line and one action per state", async () => {
    const wrapper = mount(ConnectPanel, {
      props: {
        connect,
        relayUrl: "https://vitehub.dev/docs/relay",
        states: {
          github: { message: "GitHub blocked the request", status: "blocked", command: "npx vitehub deploy" },
          openai: { account: "acme", status: "connected" },
          vercel: { status: "error" },
        },
      },
    });
    expect(wrapper.findAll("h3").map(heading => heading.text())).toEqual(["Deploy", "Source", "Model keys"]);
    const row = (name: string) => wrapper.get(`[data-provider='${name}']`);
    expect(row("anthropic").text()).toContain("Paste a token");
    expect(row("cloudflare").text()).toContain("Needs a relay. Cloudflare does not accept browser requests.");
    expect(row("cloudflare").get("a").attributes("href")).toBe("https://vitehub.dev/docs/relay");
    expect(row("openai").text()).toContain("acme · OPENAI_API_KEY");
    expect(row("vercel").text()).toContain("Vercel rejected the token. Paste a new one.");
    expect(row("github").text()).toContain("Set up relay");
    await row("github").findAll("button").find(button => button.text() === "Copy command")?.trigger("click");
    expect(wrapper.emitted("copy-command")).toEqual([["npx vitehub deploy"]]);

    await row("openai").get("button").trigger("click");
    expect(wrapper.emitted("disconnect")).toEqual([["openai"]]);
    await wrapper.findAll("button").find(button => button.text() === "Remove all")?.trigger("click");
    expect(wrapper.emitted("remove-all")).toHaveLength(1);
    expect(wrapper.get("footer").text()).toContain("ViteHub servers never receive them.");
  });

  it("says when a page needs no accounts", () => {
    const wrapper = mount(ConnectPanel, { props: { connect: defineConnect({}), empty: "No accounts needed for this step." } });
    expect(wrapper.text()).toBe("No accounts needed for this step.");
    expect(wrapper.find("footer").exists()).toBe(false);
  });

  it("asks for a token in a labeled password input", async () => {
    const wrapper = mount(ConnectPanel, { attachTo: document.body, props: { connect } });
    await wrapper.get("[aria-label='Connect Anthropic']").trigger("click");
    // The field is Nuxt UI's UInput, which loads on first render and takes focus.
    await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.find("input").element), { timeout: 5_000 });
    const input = wrapper.get("input");
    expect(input.attributes()).toMatchObject({ autocomplete: "off", type: "password" });
    expect(wrapper.get(`label[for='${input.attributes("id")}']`).text()).toBe("Anthropic token");
    expect(wrapper.get(".vh-ws-token-form a").text()).toBe("Create a token");
    await input.setValue("sk-ant-1");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("connect")).toEqual([["anthropic", "sk-ant-1"]]);
    expect(wrapper.find("input").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps tokens in sessionStorage and maps them to env", () => {
    const store = useConnectStore();
    store.set("openai", "sk-1");
    expect(JSON.parse(sessionStorage.getItem("vitehub:connect") ?? "{}")).toEqual({ openai: "sk-1" });
    expect(useConnectStore().credentials.value).toEqual({ openai: "sk-1" });
    const env = store.env(connect);
    expect(env.value).toEqual({ OPENAI_API_KEY: "sk-1" });
    store.remove("openai");
    expect(env.value).toEqual({});
    store.set("github", "ghp");
    store.clear();
    expect(sessionStorage.getItem("vitehub:connect")).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
