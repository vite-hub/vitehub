export const docsLanes = ["agents", "server-primitives"] as const;

export type DocsLane = (typeof docsLanes)[number];

export function parseDocsLane(value: unknown): DocsLane | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return docsLanes.includes(candidate as DocsLane) ? candidate as DocsLane : null;
}

export function parseDocsLanes(value: unknown): DocsLane[] | null {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map(candidate => candidate.trim())
      : [];
  const lanes = docsLanes.filter(lane => candidates.includes(lane));

  return lanes.length > 0 ? lanes : null;
}
