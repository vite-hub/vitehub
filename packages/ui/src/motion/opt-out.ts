export const optOut = '[data-motion="none"]';

export function isMotionOff(element: Element): boolean {
  let node: Element | null = element;
  while (node) {
    if (node.closest(optOut)) return true;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}
