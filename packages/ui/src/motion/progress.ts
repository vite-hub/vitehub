import { cubicBezier, easeOut, playTween } from "./helpers/tween.ts";
import { isMotionOff } from "./layer.ts";
import { prefersReducedMotion } from "./reduced-motion.ts";
import { createSpring, onEachFrame, springs } from "./spring.ts";

const svgNs = "http://www.w3.org/2000/svg";
// The numbers of the prototype's upload: a 2px rail, a 4px bar, and a head 4px thicker over 10px at its end. The wave of
// the processing phase is 4px over 36px and runs at 260px a second. It flattens in a third of a second when the work is
// done. Then a dot grows to 3.5, settles at 2 in 320ms, and shrinks in 120ms while the check draws in 320ms.
const height = 8;
const rail = 2;
const bar = 4;
const bulge = 4;
const headWidth = 10;
const waveWidth = 36;
const waveSpeed = 260;
const settleRate = 3;
const tickEasing = cubicBezier(0.6, 0, 0.2, 1);
const tickPath = "M5 12.5l4.5 4.5L19 7.5";

export type ProgressPhase = "idle" | "fill" | "wave" | "done";

export interface ProgressOptions {
  /** The accessible name of the bar, such as "Upload cover.png". */
  label?: string;
}

export interface Progress {
  readonly phase: ProgressPhase;
  /**
   * A fraction from 0 to 1 fills the bar, with a head at its end. `null` shows the wave: work runs with no known
   * total, such as a server that makes previews after the upload.
   */
  set(value: number | null): void;
  /** The work is done: the bar fills, its head or wave flattens, and a dot draws into a check. */
  done(): void;
  /** Back to an empty bar. */
  reset(): void;
  /** Stops the motion and removes what the helper added. */
  destroy(): void;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/**
 * A line from `x0` to `x1` with round ends, `thickness(x)` thick at each x: the prototype's canvas line as SVG path
 * data, so the bar keeps its shape at any width.
 */
function line(x0: number, x1: number, thickness: (x: number) => number): string {
  const y = height / 2;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let x = x0; x <= x1 + 0.01; x += 1.5) {
    const half = thickness(Math.min(x, x1)) / 2;
    top.push(`${Math.min(x, x1).toFixed(2)} ${(y - half).toFixed(2)}`);
    bottom.unshift(`${Math.min(x, x1).toFixed(2)} ${(y + half).toFixed(2)}`);
  }
  if (!top.length) return "";
  const end = thickness(x1) / 2;
  const start = thickness(x0) / 2;
  return `M${top.join("L")}A${end.toFixed(2)} ${end.toFixed(2)} 0 0 1 ${bottom[0]}L${bottom.join("L")}A${start.toFixed(2)} ${start.toFixed(2)} 0 0 1 ${top[0]}Z`;
}

/**
 * The progress helper of docs/design/motion.md: "Work runs". It draws into `host`: a bar with a head while it fills, a
 * wave while it processes with no known total, and a dot that draws into a check when the work is done.
 *
 * The host gets `role="progressbar"` with `aria-valuenow` from 0 to 100, no `aria-valuenow` during the wave, and
 * `data-phase`. The bar uses `currentColor`, and the rail `--vh-progress-rail` or the Nuxt UI accented border color.
 * Under reduced motion the bar jumps to its value, there is no head or wave, and the check cross-fades in 150ms. Inside
 * `data-motion="none"` the bar jumps and the check shows at once.
 */
export function createProgress(host: HTMLElement, options: ProgressOptions = {}): Progress {
  const chart = svg("svg", { "aria-hidden": "true", "data-part": "bar", height: String(height), preserveAspectRatio: "none" });
  const railPath = svg("path", { "data-part": "rail", fill: "var(--vh-progress-rail, var(--ui-border-accented, color-mix(in oklch, currentColor 20%, transparent)))" });
  const fillPath = svg("path", { "data-part": "fill", fill: "currentColor" });
  chart.append(railPath, fillPath);
  const check = svg("svg", { "aria-hidden": "true", "data-part": "check", fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": "2", viewBox: "0 0 24 24" });
  const dot = svg("circle", { cx: "12", cy: "12", fill: "currentColor", r: "0", stroke: "none" });
  const tick = svg("path", { d: tickPath, pathLength: "1", "stroke-dasharray": "1", "stroke-dashoffset": "1" });
  check.append(dot, tick);
  Object.assign(chart.style, { display: "block", flex: "1 1 auto", minWidth: "0", overflow: "visible", width: "100%" });
  Object.assign(check.style, { flex: "none", height: "18px", width: "18px" });
  if (!host.style.display) Object.assign(host.style, { alignItems: "center", display: "flex", gap: "8px" });
  host.append(chart, check);
  host.setAttribute("role", "progressbar");
  host.setAttribute("aria-valuemin", "0");
  host.setAttribute("aria-valuemax", "100");
  if (options.label && !host.hasAttribute("aria-label")) host.setAttribute("aria-label", options.label);

  let phase: ProgressPhase = "idle";
  let width = chart.clientWidth;
  let wave = -40;
  let flat = 0;
  let stopWave: (() => void) | undefined;
  let stopTimeline: Array<() => void> = [];
  const still = () => prefersReducedMotion() || isMotionOff(host);
  const end = createSpring(0, () => draw(), springs.snappy);

  function draw(): void {
    width = chart.clientWidth || width;
    chart.setAttribute("viewBox", `0 0 ${Math.max(1, width)} ${height}`);
    const x0 = 2;
    const x1 = Math.max(x0, width - 2);
    railPath.setAttribute("d", line(x0, x1, () => rail));
    const shape = still() ? 0 : 1 - flat;
    if (phase === "wave" || (phase === "done" && flat < 1 && stopWave)) {
      fillPath.setAttribute("d", line(x0, x1, x => bar + bulge * shape * Math.exp(-(((x - wave) / waveWidth) ** 2))));
      return;
    }
    const head = x0 + (x1 - x0) * Math.max(0, Math.min(1, end.value));
    fillPath.setAttribute("d", phase === "idle" ? "" : line(x0, Math.max(x0, head), x => bar + bulge * shape * Math.exp(-(((x - head + headWidth) / headWidth) ** 2))));
  }

  function setPhase(next: ProgressPhase): void {
    phase = next;
    host.dataset.phase = next;
    host.setAttribute("aria-busy", String(next === "fill" || next === "wave"));
  }

  function stopAll(): void {
    stopWave?.();
    stopWave = undefined;
    for (const stop of stopTimeline) stop();
    stopTimeline = [];
  }

  function startWave(): void {
    if (stopWave || still()) return;
    wave = -40;
    stopWave = onEachFrame((seconds) => {
      if (phase === "done") {
        flat = Math.min(1, flat + seconds * settleRate);
        wave += waveSpeed * seconds;
        draw();
        if (flat < 1) return true;
        end.set(1);
        stopWave = undefined;
        draw();
        drawCheck();
        return false;
      }
      wave = -40 + ((wave + 40 + waveSpeed * seconds) % (width + 80));
      draw();
      return true;
    });
  }

  function clearCheck(): void {
    dot.setAttribute("r", "0");
    tick.setAttribute("stroke-dashoffset", "1");
    check.style.opacity = "";
  }

  function drawCheck(): void {
    if (isMotionOff(host)) {
      tick.setAttribute("stroke-dashoffset", "0");
      return;
    }
    if (prefersReducedMotion()) {
      check.style.opacity = "0";
      tick.setAttribute("stroke-dashoffset", "0");
      const fade = playTween(0.15, p => (check.style.opacity = p.toFixed(3)));
      stopTimeline.push(fade.stop);
      return;
    }
    const grow = playTween(0.32, (p) => {
      dot.setAttribute("r", (p <= 0.5 ? 7 * p : 3.5 - 3 * (p - 0.5)).toFixed(3));
    }, easeOut);
    stopTimeline.push(grow.stop);
    void grow.done.then((completed) => {
      if (!completed) return;
      const shrink = playTween(0.12, p => dot.setAttribute("r", (2 - 2 * p).toFixed(3)));
      const draw = playTween(0.32, p => tick.setAttribute("stroke-dashoffset", (1 - p).toFixed(4)), tickEasing);
      stopTimeline.push(shrink.stop, draw.stop);
    });
  }

  // The bar fills to its end, its head flattens, then the check draws.
  function settleFill(): void {
    if (still()) {
      flat = 1;
      draw();
      drawCheck();
      return;
    }
    const wait = onEachFrame(() => {
      if (end.active) return true;
      const flatten = playTween(1 / settleRate, (p) => {
        flat = p;
        draw();
      });
      stopTimeline.push(flatten.stop);
      void flatten.done.then(completed => completed && drawCheck());
      return false;
    });
    stopTimeline.push(wait);
  }

  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => draw()) : undefined;
  resize?.observe(chart);
  setPhase("idle");
  draw();

  return {
    get phase() {
      return phase;
    },
    set(value) {
      if (phase === "done") {
        stopAll();
        clearCheck();
        flat = 0;
      }
      if (value === null) {
        host.removeAttribute("aria-valuenow");
        setPhase("wave");
        startWave();
        draw();
        return;
      }
      const fraction = Math.max(0, Math.min(1, value));
      host.setAttribute("aria-valuenow", String(Math.round(fraction * 100)));
      if (phase === "wave") {
        stopWave?.();
        stopWave = undefined;
      }
      if (phase !== "fill") setPhase("fill");
      if (still()) end.set(fraction);
      else end.to(fraction);
    },
    done() {
      if (phase === "done") return;
      host.setAttribute("aria-valuenow", "100");
      const fromWave = phase === "wave" && stopWave !== undefined;
      setPhase("done");
      flat = 0;
      if (fromWave) return;
      if (still()) end.set(1);
      else end.to(1);
      settleFill();
    },
    reset() {
      stopAll();
      clearCheck();
      flat = 0;
      end.set(0);
      host.setAttribute("aria-valuenow", "0");
      setPhase("idle");
      draw();
    },
    destroy() {
      stopAll();
      end.stop();
      resize?.disconnect();
      chart.remove();
      check.remove();
    },
  };
}
