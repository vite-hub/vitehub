/** A locator: a CSS selector and an optional text that the element must contain. */
export interface LocatorSpec {
  hasText?: string
  selector: string
}

/**
 * Source text of a locator operation. CDP `Runtime.evaluate` runs it in the remote page, so its errors are plain.
 * `evaluateResult()` turns a thrown error into `BROWSER_PROVIDER_ERROR`.
 */
export function locatorExpression(
  operation: "click" | "count" | "fill" | "inputValue" | "visible",
  locator: LocatorSpec,
  value?: string,
) {
  return `(() => {
    const spec = ${JSON.stringify(locator)};
    const elements = [...document.querySelectorAll(spec.selector)]
      .filter(element => !spec.hasText || element.textContent?.includes(spec.hasText));
    const element = elements[0];
    if (${JSON.stringify(operation)} === "count") return elements.length;
    if (${JSON.stringify(operation)} === "visible") {
      if (!(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
    if (${JSON.stringify(operation)} === "click") {
      if (!(element instanceof Element)) throw new Error("Browser locator did not match an element");
      element.scrollIntoView({ block: "center", inline: "center" });
      const rects = [...element.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      for (const rect of rects) {
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit && (hit === element || element.contains(hit))) return point;
      }
      if (rects.length === 0) throw new Error("Browser locator matched a non-actionable element");
      throw new Error("Browser locator target is covered by another element");
    }
    if (!(element instanceof HTMLElement)) throw new Error("Browser locator did not match an HTML element");
    if (${JSON.stringify(operation)} === "inputValue") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          throw new Error("Browser locator does not support inputValue() for this element");
      }
      return element.value;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Browser locator does not support fill() for this element");
    }
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Browser locator could not set the element value");
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`
}
