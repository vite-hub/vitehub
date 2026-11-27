// One polite live region per dialog, or one for the page, that parts use to announce a short result such as "Copied".
// A region must exist before its text changes, so a part calls `prepareAnnouncer()` when it mounts. A modal dialog hides
// the rest of the page from screen readers, so a part inside a dialog announces through a region inside that dialog.

const regionSlot = "live-announcer";
// Visually hidden, so the region needs no stylesheet.
const hidden = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0";

function regionFor(element: Element): HTMLElement {
  const container = element.closest<HTMLElement>("[role=dialog], [role=alertdialog]") ?? element.ownerDocument.body;
  for (const child of container.children) {
    if (child instanceof HTMLElement && child.dataset.slot === regionSlot) return child;
  }
  const region = element.ownerDocument.createElement("div");
  region.dataset.slot = regionSlot;
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  region.style.cssText = hidden;
  container.append(region);
  return region;
}

/** Adds the live region that `announce()` will use for `element`, so that the first message is read. */
export function prepareAnnouncer(element: Element | null | undefined): void {
  if (element) regionFor(element);
}

const clearTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Reads `message` to screen readers without moving focus, and clears it after `duration` ms. */
export function announce(element: Element | null | undefined, message: string, duration = 2_000): void {
  if (!element) return;
  const region = regionFor(element);
  clearTimeout(clearTimers.get(region));
  // Empty first, so the same message twice in a row is read twice.
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = message;
  });
  clearTimers.set(region, setTimeout(() => (region.textContent = ""), duration));
}
