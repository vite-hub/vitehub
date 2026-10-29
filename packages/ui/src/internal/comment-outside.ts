import { onBeforeUnmount, onMounted } from "vue";

// A pointerdown that a composer or a thread already used. The comment layer skips it, so one click never does two things.
export const consumedPointerEvents = new WeakSet<Event>();

// A pointerdown that was stopped still ends in a click. Swallow that click too, so a pin under the pointer does not open.
export function swallowNextClick(): void {
  const stop = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    cleanup();
  };
  const cleanup = () => {
    document.removeEventListener("click", stop, true);
    document.removeEventListener("pointerdown", cleanup, true);
  };
  document.addEventListener("click", stop, true);
  document.addEventListener("pointerdown", cleanup, true);
}

// Runs `handler` for every pointerdown on the page, before the page sees it.
export function useDocumentPointerDown(handler: (event: Event) => void): void {
  onMounted(() => document.addEventListener("pointerdown", handler, true));
  onBeforeUnmount(() => document.removeEventListener("pointerdown", handler, true));
}

export const shakeEventName = "comments:shake";

const dirtySelector = "[data-slot='comment-composer'][data-dirty='true']";

// A composer with text, the new comment, a reply, or an edit, keeps the page from closing it by accident.
// Look in the root of the comment UI, which is a shadow root when the overlay lives in one.
export function hasDirtyComposer(root: ParentNode = document): boolean {
  return root.querySelector(dirtySelector) !== null;
}

// Shakes every composer that has text. Returns whether there was one.
export function shakeDirtyComposers(root: ParentNode = document): boolean {
  const dirty = [...root.querySelectorAll(dirtySelector)];
  for (const composer of dirty) composer.dispatchEvent(new CustomEvent(shakeEventName));
  return dirty.length > 0;
}

// Events from a shadow root are retargeted to their host at the document, so read the real elements from the composed path.
export const pathOf = (event: Event): Element[] => event.composedPath().filter((node): node is Element => node instanceof Element);
