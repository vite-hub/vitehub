// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
  Bubble,
  BubbleContent,
  BubbleReactions,
  Marker,
  MarkerContent,
  MarkerIcon,
  Message,
  MessageContent,
  MessageFooter,
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../src/index.ts";

const ButtonStub = defineComponent({
  setup(_props, { attrs, slots }) {
    return () => h("button", { ...attrs, "data-stub": "UButton" }, slots.default?.());
  },
});

describe("shadcn/ui parts", () => {
  it("renders a conversation turn with the shadcn/ui slots and variants", () => {
    const wrapper = mount(() =>
      h(Message, { align: "end", class: "max-w-sm" }, () =>
        h(MessageContent, () => [
          h(Bubble, { variant: "secondary" }, () => [
            h(BubbleContent, { as: "a", href: "/docs" }, () => "Read the docs"),
            h(BubbleReactions, { side: "top" }, () => "👍"),
          ]),
          h(MessageFooter, () => "Sent"),
        ]),
      ),
    );

    const message = wrapper.get("[data-slot=message]");
    expect(message.attributes()).toMatchObject({ class: "max-w-sm", "data-align": "end" });
    expect(wrapper.get("[data-slot=bubble]").attributes()).toMatchObject({ "data-align": "start", "data-variant": "secondary" });
    const content = wrapper.get("[data-slot=bubble-content]");
    expect(content.element.tagName).toBe("A");
    expect(content.attributes("href")).toBe("/docs");
    expect(wrapper.get("[data-slot=bubble-reactions]").attributes()).toMatchObject({ "data-align": "end", "data-side": "top" });
    expect(wrapper.get("[data-slot=message-footer]").text()).toBe("Sent");
  });

  it("renders markers as separators or links and hides their icons", () => {
    const wrapper = mount(() => [
      h(Marker, { variant: "separator" }, () => h(MarkerContent, () => "Today")),
      h(Marker, { as: "a", href: "#latest" }, () => [h(MarkerIcon, () => "•"), h(MarkerContent, () => "Jump to latest")]),
    ]);

    const [separator, link] = wrapper.findAll("[data-slot=marker]");
    expect(separator!.attributes("data-variant")).toBe("separator");
    expect(link!.element.tagName).toBe("A");
    expect(link!.attributes()).toMatchObject({ "data-variant": "default", href: "#latest" });
    expect(wrapper.get("[data-slot=marker-icon]").attributes("aria-hidden")).toBe("true");
  });

  it("renders trace lines with status, icon, title, and description", () => {
    const wrapper = mount(() =>
      h(Trace, () => [
        h(TraceLine, { status: "running" }, () => [
          h(TraceIcon, () => "⟳"),
          h(TraceTitle, () => "Running pnpm build"),
          h(TraceDescription, () => "4 s"),
        ]),
        h(TraceLine, () => h(TraceTitle, () => "Ran pnpm install")),
      ]),
    );

    const [running, done] = wrapper.findAll("[data-slot=trace-line]");
    expect(running!.element.tagName).toBe("SPAN");
    expect(running!.attributes("data-status")).toBe("running");
    expect(done!.attributes("data-status")).toBeUndefined();
    expect(wrapper.get("[data-slot=trace-icon]").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get("[data-slot=trace-description]").text()).toBe("4 s");
  });

  it("expands a trace line with a native button and supports v-model:open", async () => {
    const open = ref(false);
    const wrapper = mount(
      () =>
        h(Trace, () =>
          h(
            TraceCollapsible,
            { open: open.value, "onUpdate:open": (value: boolean) => (open.value = value) },
            () => [
              h(TraceCollapsibleTrigger, () => h(TraceLine, () => h(TraceTitle, () => "Ran node --version"))),
              h(TraceCollapsibleContent, { class: "font-mono" }, () => "v24.18.0"),
            ],
          ),
        ),
      { attachTo: document.body },
    );

    const trigger = wrapper.get("[data-slot=trace-collapsible-trigger]");
    expect(trigger.element.tagName).toBe("BUTTON");
    expect(trigger.attributes()).toMatchObject({ "aria-expanded": "false", type: "button" });
    expect(wrapper.find("[data-slot=trace-collapsible-content-inner]").exists()).toBe(false);

    await trigger.trigger("click");
    await nextTick();
    expect(open.value).toBe(true);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    const inner = wrapper.get("[data-slot=trace-collapsible-content-inner]");
    expect(inner.attributes("class")).toBe("font-mono");
    expect(inner.text()).toBe("v24.18.0");
    expect(trigger.attributes("aria-controls")).toBe(wrapper.get("[data-slot=trace-collapsible-content]").attributes("id"));
    wrapper.unmount();
  });

  it("renders an attachment with its state and a full-size native trigger", () => {
    const wrapper = mount(
      () =>
        h(Attachment, { orientation: "vertical", size: "sm", state: "uploading" }, () => [
          h(AttachmentTrigger, { "aria-label": "Open report.pdf" }),
          h(AttachmentMedia, { variant: "image" }, () => h("img", { alt: "", src: "/report.png" })),
          h(AttachmentContent, () => h(AttachmentTitle, () => "report.pdf")),
          h(AttachmentAction, { "aria-label": "Remove report.pdf", icon: "i-ph-x-light" }),
        ]),
      { global: { components: { UButton: ButtonStub } } },
    );

    expect(wrapper.get("[data-slot=attachment]").attributes()).toMatchObject({
      "data-orientation": "vertical",
      "data-size": "sm",
      "data-state": "uploading",
    });
    expect(wrapper.get("[data-slot=attachment-trigger]").attributes()).toMatchObject({ "aria-label": "Open report.pdf", type: "button" });
    expect(wrapper.get("[data-slot=attachment-media]").attributes("data-variant")).toBe("image");
    expect(wrapper.get("[data-stub=UButton]").attributes()).toMatchObject({
      "aria-label": "Remove report.pdf",
      color: "neutral",
      "data-slot": "attachment-action",
      size: "xs",
      variant: "ghost",
    });
  });

  it("renders on the server", async () => {
    const html = await renderToString(
      createSSRApp(() =>
        h(Trace, () =>
          h(TraceCollapsible, { defaultOpen: true }, () => [
            h(TraceCollapsibleTrigger, () => h(TraceLine, { status: "error" }, () => h(TraceTitle, () => "Failed to run pnpm lint"))),
            h(TraceCollapsibleContent, () => "2 errors"),
          ]),
        ),
      ),
    );
    expect(html).toContain('data-slot="trace-line" data-status="error"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("2 errors");
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    const document = new DOMParser().parseFromString(html, "text/html");
    const contentId = document.querySelector("[data-slot=trace-collapsible-content]")?.id;
    expect(controls).toBeTruthy();
    expect(controls).toBe(contentId);
  });

  it("styles parts in the components layer so utility classes win", () => {
    const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");
    expect(stylesheet.trimStart().split("\n")[1]).toBe("@layer theme, base, components, utilities;");
    const parts = stylesheet.slice(stylesheet.indexOf("@layer components {"));
    for (const slot of ["message", "bubble-content", "marker", "trace-line", "trace-collapsible-content-inner", "attachment"])
      expect(parts, slot).toContain(`[data-slot="${slot}"]`);
  });
});
