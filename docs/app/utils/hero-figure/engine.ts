// The engine of the primitive hero figures. Each figure is one scene. A scene is a pure function of the loop time,
// so the still frame, the tests, and the overlap check can ask for any moment.
//
// A scene either describes a lane (dashed paths, stops, small texts, boxes, and tokens: a ball that grows into a
// pill) and a timeline built with `TL()`, or it draws its own parts with `render`.
//
// Lane coordinates: x is in percent of the figure width, y is in pixels from the lane center.

import { HERO_ICONS } from "./icons";

export type Point = [number, number];
type Via = [Point, Point];
export type Keyframe = [number, Point] | [number, Point, Via];
export type Timed<V> = [number, V];

export const ease = (u: number) => (u = Math.min(Math.max(u, 0), 1), u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeIn = (u: number) => (u = Math.min(Math.max(u, 0), 1), u * u * u);
export const clamp = (u: number, a = 0, b = 1) => Math.min(Math.max(u, a), b);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** Rounds a time to 50 ms, so random timings stay readable in tests. */
export const snap = (x: number) => Math.round(x / 50) * 50;

/** A seeded random source: loop k of a figure always looks the same. */
export function rng(seed: number): () => number {
  return () => {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;

const bez = (c: Point[], u: number): Point => {
  const v = 1 - u;
  const at = (k: 0 | 1) => v * v * v * c[0]![k] + 3 * v * v * u * c[1]![k] + 3 * v * u * u * c[2]![k] + u * u * u * c[3]![k];
  return [at(0), at(1)];
};
/** The S curve between two points: it leaves and arrives flat, so a change of row looks smooth. */
export const sc = (a: Point, b: Point): Point[] => {
  const d = (b[0] - a[0]) * 0.45;
  return [a, [a[0] + d, a[1]], [b[0] - d, b[1]], b];
};
const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
/** Full text on wide figures, short text on narrow ones. */
export const fs = (full: string, short: string) => `<span class="full">${full}</span><span class="short">${short}</span>`;

/**
 * Position from keyframes. Two frames with the same point hold still. Two frames with different points move along
 * the S curve (or along `via`, two control points) with an ease in and out.
 */
export function kf(t: number, frames: Keyframe[]): Point {
  const first = frames[0]!;
  if (t <= first[0]) return first[1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [t0, a] = frames[i]!;
    const [t1, b, via] = frames[i + 1]!;
    if (t < t1) {
      if (same(a, b)) return a;
      return bez(via ? [a, via[0], via[1], b] : sc(a, b), ease((t - t0) / (t1 - t0)));
    }
  }
  return frames[frames.length - 1]![1];
}

/** The last value whose time is not after t. Before the first time: `before`. */
export function val<V>(t: number, list: Timed<V>[], before?: V): V | undefined {
  let v = before;
  for (const [at, x] of list) {
    if (t >= at) v = x;
    else break;
  }
  return v;
}

export type PathPoint = Point | { to: Point; via: Via };
const end = (p: PathPoint): Point => Array.isArray(p) ? p : p.to;

/** The SVG path of a chain of points, with an S curve between each pair, or a cubic with `via`. */
export function pathD(points: PathPoint[], H: number): string {
  const Y = ([x, y]: Point) => `${x} ${H / 2 + y}`;
  let d = `M${Y(end(points[0]!))}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (!Array.isArray(p)) {
      d += ` C ${Y(p.via[0])}, ${Y(p.via[1])}, ${Y(p.to)}`;
      continue;
    }
    const c = sc(end(points[i - 1]!), p);
    d += ` C ${Y(c[1]!)}, ${Y(c[2]!)}, ${Y(c[3]!)}`;
  }
  return d;
}

/** How a token looks from a moment on. Without a look, a token is hidden. */
export interface Look {
  open?: boolean;
  tone?: string;
  /** "spin", "ok", or "err". */
  tail?: string;
  text?: string;
  small?: boolean;
  dx?: number | ((t: number) => number);
  hidden?: boolean;
  a?: number;
}
export interface TokenState extends Omit<Look, "dx"> {
  p: Point;
  dx?: number;
}
/** The value of a stop, path, or box is its extra class. A text shows a string, or a string with a tone. */
export type TextValue = string | number | { v: string; tone?: string };
export type Value = TextValue | null | false | undefined;
export type SetValue = Value | ((t: number) => Value);
export type Kind = "stop" | "text" | "path" | "box";

export interface Timeline {
  pos: Record<string, Keyframe[]>;
  look: Record<string, Timed<Look>[]>;
  fades: Record<string, [number, number][]>;
  sets: Record<Kind, Record<string, Timed<SetValue>[]>>;
  steps: Timed<number>[];
}

/** Every plan has a loop length and the time of its still frame. */
export interface Plan {
  len: number;
  end?: number;
}
export type TimelinePlan<E extends object = object> = E & { len: number; end: number; T: Timeline };

export interface Frame {
  tok?: Record<string, TokenState>;
  stop?: Record<string, Value>;
  text?: Record<string, Value>;
  path?: Record<string, Value>;
  box?: Record<string, Value>;
  step?: number;
}

/**
 * A timeline that a scene's plan fills in. `timeline` reads it, so most scenes only describe what happens when.
 *   pos(token, time, [x, y], via?)  a keyframe for the token's place (see kf)
 *   look(token, time, look)         from this time, how the token looks
 *   fade(token, from, to)           the token fades out between two times
 *   set(kind, id, time, value)      kind is "stop", "text", "path", or "box". A function value gets the time.
 *   step(time, index)               the caption to show from this time
 */
export function TL() {
  const T: Timeline = { pos: {}, look: {}, fades: {}, sets: { stop: {}, text: {}, path: {}, box: {} }, steps: [] };
  const byTime = <V>(l: Timed<V>[] | Keyframe[]) => l.sort((a, b) => a[0] - b[0]);
  const tl = {
    T,
    pos(k: string, t: number, p: Point, via?: Via) {
      (T.pos[k] ??= []).push(via ? [t, p, via] : [t, p]);
      return tl;
    },
    look(k: string, t: number, l: Look) {
      (T.look[k] ??= []).push([t, l]);
      return tl;
    },
    fade(k: string, a: number, b: number) {
      (T.fades[k] ??= []).push([a, b]);
      return tl;
    },
    set(kind: Kind, id: string, t: number, v: SetValue) {
      (T.sets[kind][id] ??= []).push([t, v]);
      return tl;
    },
    step(t: number, i: number) {
      T.steps.push([t, i]);
      return tl;
    },
    done<E extends object = object>(len: number, end: number, extra?: E): TimelinePlan<E> {
      for (const l of Object.values(T.pos)) byTime(l);
      for (const l of Object.values(T.look)) byTime(l);
      for (const kind of Object.values(T.sets)) for (const l of Object.values(kind)) byTime(l);
      byTime(T.steps);
      return { ...(extra ?? {}) as E, len, end, T };
    },
  };
  return tl;
}

/** The frame of a timeline plan at time t. */
export function timeline(t: number, plan: { T: Timeline }): Frame {
  const T = plan.T;
  const out: Required<Omit<Frame, "step">> & { step: number } = { tok: {}, stop: {}, text: {}, path: {}, box: {}, step: 0 };
  for (const [k, frames] of Object.entries(T.pos)) {
    const look: Look = val(t, T.look[k] ?? [], { hidden: true }) ?? { hidden: true };
    let a = look.a ?? 1;
    for (const [x, y] of T.fades[k] ?? []) if (t >= x) a = Math.min(a, 1 - clamp((t - x) / (y - x)));
    out.tok[k] = { ...look, a, dx: typeof look.dx === "function" ? look.dx(t) : look.dx, p: kf(t, frames) };
  }
  for (const kind of ["stop", "text", "path", "box"] as const) {
    for (const [id, list] of Object.entries(T.sets[kind])) {
      const v = val(t, list);
      out[kind][id] = typeof v === "function" ? v(t) : v;
    }
  }
  out.step = val(t, T.steps, 0) ?? 0;
  return out;
}

/** An inline SVG icon from the figures' icon set, such as "simple-icons:slack" or "lucide:lock". */
export function icon(name: string, size = 16, cls = ""): string {
  const i = HERO_ICONS[name];
  if (!i) return `<span class="icon-missing">${name}</span>`;
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 ${i.w} ${i.h}" aria-hidden="true">${i.body}</svg>`;
}
/** Makes one element from HTML. */
export const h = <E extends Element = HTMLElement>(html: string): E => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  const el = t.content.firstElementChild;
  if (!el) throw new Error(`hero figure: no element in ${html.slice(0, 40)}`);
  return el as E;
};
/** The first element that matches, or an error: a scene builds its own DOM, so a miss is a bug. */
export const q = <E extends Element = HTMLElement>(root: ParentNode, sel: string): E => {
  const el = root.querySelector<E>(sel);
  if (!el) throw new Error(`hero figure: no ${sel}`);
  return el;
};
export const qa = <E extends Element = HTMLElement>(root: ParentNode, sel: string): E[] => [...root.querySelectorAll<E>(sel)];
/** 0 before `a`, 1 after `b`, eased in between. */
export const prog = (t: number, a: number, b: number) => ease((t - a) / (b - a));
/** Toggles a class only when it changes. */
export const cls = (el: Element, name: string, on: unknown) => {
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
};
/** Sets HTML only when it changes. */
export const put = (el: HTMLElement, html: string) => {
  if (el.dataset.v !== html) {
    el.dataset.v = html;
    el.innerHTML = html;
  }
};

export interface Head {
  x: number;
  label: string;
  name?: string;
  align?: "l" | "r";
}
export interface LanePath {
  pts: PathPoint[];
  id?: string;
  cls?: string;
}
export interface Stop {
  id: string;
  x: number;
  y: number;
  cls?: string;
}
export interface Text {
  id: string;
  x: number;
  y: number;
  cls?: string;
  align?: "l" | "c" | "r";
}
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cls?: string;
  label?: string;
}

/** Draws one moment and returns the caption index. */
export type Update<P> = (t: number, plan: P, still: boolean) => number | void;

export interface Scene<P extends Plan = Plan> {
  /** The primitive, such as "kv". The figure's class is `vh-hero-<key>`, and scene CSS is scoped under it. */
  key: string;
  name: string;
  /** What the figure shows, for readers who cannot see it. */
  label: string;
  /** The height of the lane or stage in px. */
  H?: number;
  heads?: Head[];
  paths?: LanePath[];
  stops?: Stop[];
  texts?: Text[];
  boxes?: Box[];
  tokens?: string[];
  /** One plain sentence per step. The figure shows the current one. */
  steps: string[] | ((plan: P) => string[]);
  /** The sentence of the still frame, for readers who turn motion off. */
  summary: string;
  /** The choices of loop k. The same k always gives the same plan. */
  plan: (k: number) => P;
  /** A lane scene's frame. Scenes with a `TL()` plan leave it out and use `timeline`. */
  frame?: (t: number, plan: P) => Frame;
  /** A scene that draws its own parts builds them in `stage` once and returns its update function. */
  render?: (stage: HTMLElement, scene: Scene<P>) => Update<P>;
  /** CSS for the scene's own parts, scoped under `.vh-hero-<key>`. */
  css?: string;
}

export const defineScene = <P extends Plan>(scene: Scene<P>): Scene<P> => scene;

export interface HeroFigure {
  /** Draws the moment t of the current plan. */
  draw: (t: number, still?: boolean) => void;
  plan: () => Plan;
  /** Switches to the plan of loop k. */
  use: (k: number) => void;
  pause: () => void;
  play: () => void;
  destroy: () => void;
}

/** What the caption under the figure shows. */
export interface HeroCaption {
  text: string;
  step: number;
  steps: number;
  still: boolean;
}

const stepsOf = <P extends Plan>(scene: Scene<P>, plan: P) => typeof scene.steps === "function" ? scene.steps(plan) : scene.steps;
const styled = new Set<string>();

/** Builds the figure inside `host` and runs it while it is on screen. */
export function mountHeroFigure<P extends Plan>(scene: Scene<P>, host: HTMLElement, opts: { reduce: boolean; onCaption: (caption: HeroCaption) => void }): HeroFigure {
  const H = scene.H ?? 150;
  const id = (s: string) => `vh-hero-${scene.key}-${s}`;
  if (scene.css && !styled.has(scene.key)) {
    styled.add(scene.key);
    document.head.insertAdjacentHTML("beforeend", `<style data-hero-figure="${scene.key}">${scene.css}</style>`);
  }
  const fig = document.createElement("div");
  fig.className = `vh-fig vh-hero-${scene.key}`;
  const heads = (scene.heads ?? []).map(x => `<div class="head ${x.align ?? ""}" style="--x:${x.x}"><span class="lbl">${x.label}</span>${x.name ? `<span class="nm">${x.name}</span>` : ""}</div>`).join("");
  const paths = (scene.paths ?? []).map((p, i) => `<path id="${id(`p${p.id ?? i}`)}" class="${p.cls ?? ""}" d="${pathD(p.pts, H)}"/>`).join("");
  const boxes = (scene.boxes ?? []).map(b => `<div class="box ${b.cls ?? ""}" id="${id(`b${b.id}`)}" style="--x:${b.x};--y:${b.y};--w:${b.w};--h:${b.h}">${b.label ? `<span class="box-label">${b.label}</span>` : ""}</div>`).join("");
  const stops = (scene.stops ?? []).map(s => `<span class="stop ${s.cls ?? ""}" id="${id(`s${s.id}`)}" style="--x:${s.x};--y:${s.y}"></span>`).join("");
  const texts = (scene.texts ?? []).map(s => `<span class="txt ${s.align ?? "c"} ${s.cls ?? ""}" id="${id(`t${s.id}`)}" style="--x:${s.x};--y:${s.y}"></span>`).join("");
  const tokens = (scene.tokens ?? []).map(k => `<span class="job" id="${id(`k${k}`)}"><span class="body"><span class="lab"></span><span class="tail"></span></span></span>`).join("");
  fig.innerHTML = `${scene.heads?.length ? `<div class="heads" aria-hidden="true">${heads}</div>` : ""}
    <div class="lane" style="height:${H}px" aria-hidden="true">
      <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${boxes}${stops}${texts}${tokens}
    </div>`;
  host.replaceChildren(fig);
  const lane = q(fig, ".lane");
  const custom = scene.render ? scene.render(lane, scene) : null;
  if (custom) lane.classList.add("stage");

  const $ = (s: string) => q(fig, `#${id(s)}`);
  let loop = 0;
  let plan = scene.plan(0);
  let lastCap = "";

  function frameAt(t: number, still: boolean): Frame {
    if (custom) return { step: custom(t, plan, still) ?? 0 };
    if (scene.frame) return scene.frame(t, plan);
    if ("T" in plan) return timeline(t, plan as Plan & { T: Timeline });
    return {};
  }

  function draw(t: number, still = false) {
    const tc = Math.min(Math.max(t, 0), plan.len - 1);
    const f = frameAt(tc, still);
    for (const k of scene.tokens ?? []) {
      const el = $(`k${k}`);
      const s: TokenState = f.tok?.[k] ?? { hidden: true, p: [0, 0] };
      el.style.setProperty("--x", s.p[0].toFixed(3));
      el.style.setProperty("--y", s.p[1].toFixed(2));
      el.style.setProperty("--dx", (s.dx ?? 0).toFixed(2));
      el.style.setProperty("--a", s.hidden ? "0" : (s.a ?? 1).toFixed(3));
      const c = `job ${s.tone ?? ""}${s.open ? " open" : ""}${s.small ? " small" : ""}`;
      if (el.className !== c) el.className = c;
      const lab = q(el, ".lab");
      if (s.text !== undefined && lab.dataset.v !== s.text) {
        lab.dataset.v = s.text;
        lab.innerHTML = s.text;
      }
      const tail = q(el, ".tail");
      const want = s.tail ?? "";
      if (tail.dataset.v !== want) {
        tail.dataset.v = want;
        tail.className = want === "spin" ? "tail spin" : "tail";
        tail.textContent = want === "ok" ? "✓" : want === "err" ? "✕" : "";
      }
    }
    for (const s of scene.stops ?? []) {
      const el = $(`s${s.id}`);
      const c = `stop ${s.cls ?? ""} ${f.stop?.[s.id] || ""}`;
      if (el.className !== c) el.className = c;
    }
    for (const s of scene.texts ?? []) {
      const el = $(`t${s.id}`);
      const v = f.text?.[s.id];
      const on = v !== undefined && v !== null && v !== false;
      const value = on ? (typeof v === "object" ? v.v : String(v)) : el.dataset.v ?? "";
      const tone = on && typeof v === "object" ? v.tone ?? "" : "";
      const c = `txt ${s.align ?? "c"} ${s.cls ?? ""} ${tone}${on ? " on" : ""}`;
      if (el.className !== c) el.className = c;
      if (on && el.dataset.v !== value) {
        el.dataset.v = value;
        el.innerHTML = `<span>${value}</span>`;
      }
    }
    for (const [i, p] of (scene.paths ?? []).entries()) {
      const key = p.id ?? String(i);
      const el = $(`p${key}`);
      const c = `${p.cls ?? ""} ${f.path?.[key] || ""}`;
      if (el.getAttribute("class") !== c) el.setAttribute("class", c);
    }
    for (const b of scene.boxes ?? []) {
      const el = $(`b${b.id}`);
      const c = `box ${b.cls ?? ""} ${f.box?.[b.id] || ""}`;
      if (el.className !== c) el.className = c;
    }
    fig.classList.toggle("fading", !still && t >= plan.len - 500);
    const step = f.step ?? 0;
    const text = still ? scene.summary : stepsOf(scene, plan)[step] ?? "";
    const key = `${still}:${step}:${text}`;
    if (key !== lastCap) {
      lastCap = key;
      opts.onCaption({ text, step, steps: stepsOf(scene, plan).length, still });
    }
  }

  let paused = false;
  let visible = false;
  let start: number | null = null;
  let now0 = 0;
  let raf = 0;
  const observer = new IntersectionObserver(([e]) => {
    visible = e?.isIntersecting ?? false;
    run();
  });
  function tick(now: number) {
    raf = 0;
    if (paused || !visible) return;
    if (start === null) start = now - now0;
    while (now - start >= plan.len) {
      start += plan.len;
      plan = scene.plan(++loop);
    }
    now0 = now - start;
    draw(now0);
    raf = requestAnimationFrame(tick);
  }
  function run() {
    if (!raf && visible && !paused && !opts.reduce) {
      start = null;
      raf = requestAnimationFrame(tick);
    }
  }

  const figure: HeroFigure = {
    draw,
    plan: () => plan,
    use: (k) => {
      loop = k;
      plan = scene.plan(k);
    },
    pause: () => {
      paused = true;
    },
    play: () => {
      paused = false;
      run();
    },
    destroy: () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
  if (opts.reduce) {
    draw(plan.end ?? plan.len - 600, true);
    return figure;
  }
  observer.observe(fig);
  draw(0);
  return figure;
}
