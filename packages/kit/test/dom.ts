import { createApp, nextTick, type VNode } from "vue";

export function mount(render: () => VNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const app = createApp({ render });
  app.mount(host);
  return {
    host,
    unmount() {
      app.unmount();
      host.remove();
    },
  };
}

export async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

export async function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init }));
  await settle();
}

export async function type(input: HTMLInputElement, text: string) {
  for (const data of text) {
    input.value += data;
    if (input.selectionStart !== null) input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent("input", { data, inputType: "insertText", bubbles: true }));
    await settle();
  }
}

export async function click(el: Element) {
  (el as HTMLElement).click();
  await settle();
}

export function one<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelectorAll<E>(selector);
  if (found.length !== 1) throw new Error(`Expected one ${selector}, found ${found.length}.`);
  return found[0]!;
}
