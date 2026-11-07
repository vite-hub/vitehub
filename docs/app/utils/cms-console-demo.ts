// The timeline of the CMS hero animation. A frame is a function of the time in the loop, so a test or a reader
// who turns motion off can ask for any moment.

export type CmsDemoPhase = "idle" | "typing" | "saving" | "saved" | "publishing" | "published";

export interface CmsDemoFrame {
  phase: CmsDemoPhase;
  /** The part of the new sentence that the editor shows. */
  typed: string;
  status: { label: string; tone: "neutral" | "warning" | "success" };
  /** The pointer is on Publish. */
  pointer: boolean;
  pressed: boolean;
  /** The site shows the new sentence. */
  published: boolean;
  toast: boolean;
  /** The loop is about to start again, so the new sentence fades out. */
  fading: boolean;
}

export const cmsDemoSentence = "This post went live from the Console, with no deploy.";

const typeStart = 700;
const perCharacter = 45;
const typeEnd = typeStart + cmsDemoSentence.length * perCharacter;
const savedAt = typeEnd + 600;
const pointerAt = savedAt + 500;
const pressAt = pointerAt + 900;
const publishedAt = pressAt + 800;
const toastEnd = publishedAt + 2200;

const fadeLength = 400;

/** One loop in milliseconds. */
export const cmsDemoCycle = publishedAt + 4000;
/** The last frame: the document is published and the site shows it. */
export const cmsDemoEnd = cmsDemoCycle - fadeLength - 1;

export function cmsDemoFrame(time: number): CmsDemoFrame {
  const t = Math.min(Math.max(time, 0), cmsDemoCycle - 1);
  const typedCount = Math.min(cmsDemoSentence.length, Math.max(0, Math.floor((t - typeStart) / perCharacter)));
  const phase: CmsDemoPhase = t < typeStart ? "idle"
    : t < typeEnd ? "typing"
      : t < savedAt ? "saving"
        : t < pressAt ? "saved"
          : t < publishedAt ? "publishing"
            : "published";
  const status = {
    idle: { label: "Draft", tone: "neutral" },
    typing: { label: "Unsaved changes", tone: "warning" },
    saving: { label: "Saving…", tone: "warning" },
    saved: { label: "Draft saved", tone: "neutral" },
    publishing: { label: "Draft saved", tone: "neutral" },
    published: { label: "Published", tone: "success" },
  } as const satisfies Record<CmsDemoPhase, CmsDemoFrame["status"]>;

  return {
    phase,
    typed: cmsDemoSentence.slice(0, typedCount),
    status: status[phase],
    pointer: t >= pointerAt && t < publishedAt + 600,
    pressed: t >= pressAt && t < pressAt + 160,
    published: phase === "published" && t < cmsDemoCycle - fadeLength,
    toast: t >= publishedAt && t < toastEnd,
    fading: t >= cmsDemoCycle - fadeLength,
  };
}
