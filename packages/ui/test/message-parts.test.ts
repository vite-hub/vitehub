// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { MessageParts } from "../src/components/message-parts.ts";

describe("MessageParts URLs", () => {
  it("renders only HTTP source URLs as links", () => {
    const parts: UIMessage["parts"] = [
      { sourceId: "safe", type: "source-url", url: "https://example.com/reference" },
      { sourceId: "unsafe", title: "Unsafe source", type: "source-url", url: "javascript:alert(1)" },
      { sourceId: "unsupported", type: "source-url", url: "data:text/plain,source" },
    ];
    const wrapper = mount(MessageParts, { props: { parts } });

    expect(wrapper.findAll("a").map(link => link.attributes("href"))).toEqual(["https://example.com/reference"]);
    expect(wrapper.text()).toContain("Unsafe source");
    expect(wrapper.text()).toContain("data:text/plain,source");
  });

  it("renders HTTP and package-generated data file URLs without executable schemes", () => {
    const parts: UIMessage["parts"] = [
      { filename: "safe.txt", mediaType: "text/plain", type: "file", url: "https://example.com/safe.txt" },
      { filename: "unsafe.txt", mediaType: "text/plain", type: "file", url: "javascript:alert(1)" },
      { filename: "inline.png", mediaType: "image/png", type: "file", url: "data:image/png;base64,c2FmZQ==" },
      { filename: "retained.png", mediaType: "image/png", type: "file", url: "/files/retained-image" },
      { filename: "unsafe.png", mediaType: "image/png", type: "file", url: "javascript:alert(1)" },
      { mediaType: "text/html", type: "file", url: "data:text/html,<script>alert(1)</script>" },
    ];
    const wrapper = mount(MessageParts, {
      global: { components: { UModal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }) } },
      props: { parts },
    });

    expect(wrapper.findAll("a").map(link => link.attributes("href"))).toEqual(["https://example.com/safe.txt"]);
    expect(wrapper.findAll("a")[0]!.attributes("rel")).toBe("noreferrer");
    expect(wrapper.findAll("img").map(image => image.attributes("src"))).toEqual(["data:image/png;base64,c2FmZQ==", "/files/retained-image"]);
    expect(wrapper.get("img").attributes("alt")).toBe("inline.png");
    expect(wrapper.get('[aria-label="Preview inline.png"]').attributes("type")).toBe("button");
    expect(wrapper.text()).toContain("unsafe.txt");
    expect(wrapper.text()).toContain("unsafe.png");
    expect(wrapper.text()).toContain("text/html");
  });
});
