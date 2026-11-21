export function visualCopy(element: HTMLElement): HTMLElement {
  // SAFETY: cloneNode of an HTMLElement returns an HTMLElement.
  const copy = element.cloneNode(true) as HTMLElement;
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  for (const node of [copy, ...copy.querySelectorAll("[id], [name], [form], input, button, select, textarea, fieldset")]) {
    node.removeAttribute("id");
    node.removeAttribute("name");
    node.removeAttribute("form");
    if (node.matches("input, button, select, textarea, fieldset")) node.setAttribute("disabled", "");
  }
  return copy;
}
