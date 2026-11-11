// @vitest-environment happy-dom

import { Chat as AIChat } from "@ai-sdk/vue";
import { convertToModelMessages, DefaultChatTransport, simulateReadableStream, streamText, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import UButton from "@nuxt/ui/components/Button.vue";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { Chat, PromptInput } from "../src/index.ts";

// The components must not need a ViteHub Agent. These factories throw if anything imports one.
vi.mock("@vite-hub/agent", () => {
  throw new Error("@vite-hub/ui loaded @vite-hub/agent");
});
vi.mock("@vite-hub/agent/vue", () => {
  throw new Error("@vite-hub/ui loaded @vite-hub/agent/vue");
});

const usage = { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 4, total: 4 }, outputTokens: { reasoning: 0, text: 6, total: 6 } };

// A plain AI SDK route, as in an app without `defineAgent()`: `streamText()` and `toUIMessageStreamResponse()`.
async function tutorRoute(request: Request): Promise<Response> {
  const { messages } = await request.json() as { messages: UIMessage[] };
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "**Vale** means " },
          { type: "text-delta", id: "answer", delta: "okay." },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { raw: "stop", unified: "stop" }, usage },
        ],
      }),
    },
  });
  const result = streamText({ model, messages: await convertToModelMessages(messages) });
  return result.toUIMessageStreamResponse();
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));
afterEach(() => vi.unstubAllGlobals());

describe("Chat with a plain AI SDK route", () => {
  it("renders the question and the streamed answer, and sends from PromptInput", async () => {
    const requests: Request[] = [];
    const chat = new AIChat<UIMessage>({
      transport: new DefaultChatTransport({
        api: "/api/tutor",
        fetch: async (input, init) => {
          const request = new Request(new URL(String(input), "http://localhost"), init);
          requests.push(request.clone());
          return tutorRoute(request);
        },
      }),
    });

    const Page = defineComponent({
      setup() {
        const input = ref("");
        return () =>
          h(Chat, { messages: chat.messages, status: chat.status }, {
            composer: () =>
              h(PromptInput, {
                modelValue: input.value,
                status: chat.status,
                "onUpdate:modelValue": (value: string) => {
                  input.value = value;
                },
                onSubmit: ({ text }: { text: string }) => {
                  input.value = "";
                  void chat.sendMessage({ text });
                },
                onStop: () => chat.stop(),
              }),
          });
      },
    });

    const wrapper = mount(Page, { global: { components: { UButton }, stubs: { UIcon: true } } });
    await wrapper.get("textarea").setValue("What does vale mean?");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(chat.status).toBe("ready"));
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/tutor");
    expect(chat.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const transcript = wrapper.get("[data-slot='message-scroller-content']");
    expect(transcript.text()).toContain("What does vale mean?");
    expect(transcript.text()).toContain("Vale means okay.");
    expect(transcript.find("strong").text()).toBe("Vale");
    expect(wrapper.get("textarea").element.value).toBe("");
    wrapper.unmount();
  });
});
