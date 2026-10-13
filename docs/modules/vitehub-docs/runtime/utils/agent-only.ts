/** Replaces each `agent-only` node in a minimark tree with its children, in place. */
export function unwrapAgentOnlyNodes(nodes: unknown[]) {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (!Array.isArray(node)) continue;
    // A minimark element is `[tag, props, ...children]`.
    const children = node.slice(2);
    unwrapAgentOnlyNodes(children);
    if (node[0] === "agent-only") nodes.splice(index, 1, ...children);
    else node.splice(2, node.length - 2, ...children);
  }
}
