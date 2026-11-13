import { createApp, nextTick, type VNode } from "vue";

/** Mounts a tree in the page. Call `unmount` at the end of the test. */
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

/** Lets Vue render, then lets queued microtasks and timers run. */
export async function settle() {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

/** Presses a key on an element, as the keyboard does: keydown, then keyup. */
export async function press(el: Element, key: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init }));
  await settle();
}

/** Types text at the end of an input, one `input` event per character, with a render after each, as a person types. */
export async function type(input: HTMLInputElement, text: string) {
  for (const data of text) {
    input.value += data;
    // Inputs like `type="email"` have no caret to move.
    if (input.selectionStart !== null) input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent("input", { data, inputType: "insertText", bubbles: true }));
    await settle();
  }
}

/** Clicks an element. */
export async function click(el: Element) {
  (el as HTMLElement).click();
  await settle();
}

/** The one element that matches, or an error. */
export function one<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelectorAll<E>(selector);
  if (found.length !== 1) throw new Error(`Expected one ${selector}, found ${found.length}.`);
  return found[0]!;
}
