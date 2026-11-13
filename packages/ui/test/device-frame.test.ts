// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { h, nextTick } from "vue";
import { DeviceFrame, type DeviceFrameSize } from "../src/index.ts";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

function frame(props: Record<string, unknown> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  return mount(DeviceFrame, { props, slots: { default: () => h("iframe", { title: "Page" }) } });
}
const page = (wrapper: ReturnType<typeof frame>) => wrapper.get(".vh-device-frame__page");

it("shows the content full size until device mode is on", async () => {
  const wrapper = frame();
  expect(wrapper.find("[role='toolbar']").exists()).toBe(false);
  expect(page(wrapper).attributes("style")).toBeUndefined();
  wrapper.unmount();
});

it("sizes the page to the device and keeps the same element when it turns off", async () => {
  const wrapper = frame({ defaultValue: { on: true } });
  const iframe = wrapper.get("iframe").element;
  expect(page(wrapper).attributes("style")).toContain("width: 393px");
  expect(page(wrapper).attributes("style")).toContain("height: 852px");
  await wrapper.get("[aria-label='Leave device mode']").trigger("click");
  expect(wrapper.find("[role='toolbar']").exists()).toBe(false);
  expect(wrapper.get("iframe").element).toBe(iframe);
  wrapper.unmount();
});

it("picks a device, rotates, and sets a breakpoint width", async () => {
  const wrapper = frame({ defaultValue: { on: true } });
  await wrapper.get("select").setValue("ipad");
  expect(page(wrapper).attributes("style")).toContain("width: 820px");
  await wrapper.get("button.vh-device-frame__button").trigger("click");
  expect(page(wrapper).attributes("style")).toContain("width: 1180px");
  await wrapper.get("[aria-label='Tablet, 768 pixels wide']").trigger("click");
  expect(wrapper.get("[aria-label='Tablet, 768 pixels wide']").attributes("aria-pressed")).toBe("true");
  expect((wrapper.get("select").element as HTMLSelectElement).value).toBe("custom");
  wrapper.unmount();
});

it("emits every change and holds a controlled size until the parent accepts it", async () => {
  const size: DeviceFrameSize = { on: true, id: "iphone", width: 393, height: 852, zoom: null };
  const wrapper = frame({ modelValue: size });
  await wrapper.get("[aria-label='Width']").setValue("500");
  expect(wrapper.emitted("update:modelValue")?.[0]?.[0]).toMatchObject({ id: "custom", width: 500, height: 852 });
  expect(page(wrapper).attributes("style")).toContain("width: 393px");
  await wrapper.setProps({ modelValue: { ...size, width: 500, id: "custom" } });
  expect(page(wrapper).attributes("style")).toContain("width: 500px");
  wrapper.unmount();
});

it("keeps an uncontrolled size in local storage", async () => {
  const first = frame({ storageKey: "test:device", defaultValue: { on: true } });
  await first.get("select").setValue("laptop");
  first.unmount();
  const second = frame({ storageKey: "test:device" });
  expect(page(second).attributes("style")).toContain("width: 1280px");
  second.unmount();
});

it("clamps typed sizes and resizes from a focused edge with the arrow keys", async () => {
  const wrapper = frame({ defaultValue: { on: true } });
  await wrapper.get("[aria-label='Width']").setValue("10");
  expect(page(wrapper).attributes("style")).toContain("width: 240px");
  await wrapper.get("[aria-label='Drag to change the width']").trigger("keydown", { key: "ArrowRight", shiftKey: true });
  expect(page(wrapper).attributes("style")).toContain("width: 290px");
  await wrapper.get("[aria-label='Drag to change the height']").trigger("keydown", { key: "ArrowUp" });
  expect(page(wrapper).attributes("style")).toContain("height: 842px");
  wrapper.unmount();
});

it("shows the content without the bar while disabled, and keeps the size", async () => {
  const wrapper = frame({ defaultValue: { on: true }, disabled: true });
  expect(wrapper.find("[role='toolbar']").exists()).toBe(false);
  await wrapper.setProps({ disabled: false });
  await nextTick();
  expect(wrapper.find("[role='toolbar']").exists()).toBe(true);
  wrapper.unmount();
});
