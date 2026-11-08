// The timeline of the CMS hero animation. A frame is a function of the time in the loop, so a test or a reader
// who turns motion off can ask for any moment. Every change in a frame follows an action in the scene: a keystroke,
// the autosave, the preview reload, or the click on Publish. The post starts live, so the preview shows the published
// page until the save makes a draft.

export type CmsDemoPhase = "idle" | "typing" | "saving" | "saved" | "publishing" | "published";

export interface CmsDemoStatus {
  /** The same labels as the Console editor header. */
  label: "Published" | "Saving…" | "Changed" | "Publishing…";
  tone: "neutral" | "warning" | "success";
  /** Work is in progress, so the dot pulses. */
  pending: boolean;
}

export interface CmsDemoFrame {
  phase: CmsDemoPhase;
  /** The part of the new sentence that the editor shows. */
  typed: string;
  /** The editor caret is on. It stays on while a key is down and blinks while the editor waits. */
  caret: boolean;
  /** The document has changes that are not live yet, so Publish is enabled. */
  changed: boolean;
  status: CmsDemoStatus;
  /** The pointer is on Publish. */
  pointer: boolean;
  pressed: boolean;
  /** The preview renders the page again after a save or a publish. */
  reloading: boolean;
  /** What the preview shows of the new sentence: nothing, the saved draft, or the published text. */
  sentence: "hidden" | "draft" | "live";
  /** The page the preview shows: the draft after a save, or the published page. */
  view: "draft" | "published";
  /** The loop is about to start again, so the new sentence fades out. */
  fading: boolean;
}

export const cmsDemoSentence = "Update: we now start at 8:30, so we finish before dark.";

/** The delay before each key. A person stops a little after a space and longer after a comma. */
function keyDelay(character: string): number {
  if (character === ",") return 200;
  if (character === " ") return 75;
  return 38;
}

const typeStart = 900;
const keyTimes = Array.from(cmsDemoSentence, (_, index) => {
  let time = typeStart;
  for (const character of cmsDemoSentence.slice(0, index + 1)) time += keyDelay(character);
  return time;
});
const typeEnd = keyTimes.at(-1) ?? typeStart;
const saveAt = typeEnd + 450;
const savedAt = saveAt + 550;
const reloadLength = 350;
const pointerAt = savedAt + 900;
const pressAt = pointerAt + 800;
const pressLength = 150;
const publishedAt = pressAt + 700;
const holdLength = 3600;
const fadeLength = 400;
const blink = 530;

/** One loop in milliseconds. */
export const cmsDemoCycle = publishedAt + holdLength + fadeLength;
/** The last frame: the document is published and the preview shows it. */
export const cmsDemoEnd = cmsDemoCycle - fadeLength - 1;

// With autosave the Console keeps the last state while someone types, so the header does not flicker.
const statuses = {
  idle: { label: "Published", tone: "success", pending: false },
  typing: { label: "Published", tone: "success", pending: false },
  saving: { label: "Saving…", tone: "neutral", pending: true },
  saved: { label: "Changed", tone: "warning", pending: false },
  publishing: { label: "Publishing…", tone: "neutral", pending: true },
  published: { label: "Published", tone: "success", pending: false },
} as const satisfies Record<CmsDemoPhase, CmsDemoStatus>;

export function cmsDemoFrame(time: number): CmsDemoFrame {
  const t = Math.min(Math.max(time, 0), cmsDemoCycle - 1);
  const typedCount = keyTimes.filter(keyTime => keyTime <= t).length;
  const phase: CmsDemoPhase = t < typeStart ? "idle"
    : t < saveAt ? "typing"
      : t < savedAt ? "saving"
        : t < pressAt ? "saved"
          : t < publishedAt ? "publishing"
            : "published";
  const typing = t >= typeStart && t < typeEnd + 150;
  const fading = t >= cmsDemoCycle - fadeLength;
  const draftShown = savedAt + reloadLength;
  const liveShown = publishedAt + reloadLength;

  return {
    phase,
    typed: cmsDemoSentence.slice(0, typedCount),
    caret: t < pressAt && (typing || Math.floor(t / blink) % 2 === 0),
    changed: typedCount > 0 && phase !== "published",
    status: statuses[phase],
    pointer: t >= pointerAt && t < publishedAt + 500,
    pressed: t >= pressAt && t < pressAt + pressLength,
    reloading: (t >= savedAt && t < draftShown) || (t >= publishedAt && t < liveShown),
    sentence: fading || t < draftShown ? "hidden" : t < liveShown ? "draft" : "live",
    view: t >= draftShown && t < liveShown ? "draft" : "published",
    fading,
  };
}
