/** The shapes of an icon on its 24 by 24 grid: `[tag, attributes]` for each element. */
export type IconShapes = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

const elementPattern = /<(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g;

function attributesOf(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]));
}

// The icons are drawn from elements, never from markup, so a flat list of shapes is all that they need. A Lucide icon
// with several shapes wraps them in one `<g>` that holds the stroke, so each shape takes the attributes of the group.
export function iconShapes(name: string, body: string): Array<[string, Record<string, string>]> {
  const group = /^<g((?:\s+[\w:-]+="[^"]*")*)>(.*)<\/g>$/s.exec(body);
  const shared = group ? attributesOf(group[1]!) : {};
  const content = group ? group[2]! : body;
  const found: Array<[string, Record<string, string>]> = [];
  for (const [, tag, attributes] of content.matchAll(elementPattern)) {
    if (tag === "g" || tag === "svg") throw new TypeError(`The Lucide icon "${name}" nests elements, which the UIcon of the parts does not draw.`);
    found.push([tag!, { ...shared, ...attributesOf(attributes!) }]);
  }
  if (!found.length || content.replaceAll(elementPattern, "").trim()) throw new TypeError(`The Lucide icon "${name}" has a body that the UIcon of the parts cannot draw: ${body}`);
  return found;
}

/** The stroke of every Lucide icon. An icon drawn from shapes without it sets it on its `<svg>`. */
export const lucideStroke: Readonly<Record<string, string>> = { fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": "2" };
