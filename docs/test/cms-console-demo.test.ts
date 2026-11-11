import { describe, expect, it } from "vitest";
import { cmsDemoCycle, cmsDemoEnd, cmsDemoFrame, cmsDemoSentence } from "../app/utils/cms-console-demo";

const frames = Array.from({ length: Math.ceil(cmsDemoCycle / 20) }, (_, step) => cmsDemoFrame(step * 20));

function order<T>(values: T[]): T[] {
  return values.filter((value, index) => value !== values[index - 1]);
}

describe("CMS hero animation", () => {
  // The server and readers who turn motion off see this frame, so it must tell the whole story.
  it("ends on the published document", () => {
    expect(cmsDemoFrame(cmsDemoEnd)).toMatchObject({
      phase: "published",
      typed: cmsDemoSentence,
      caret: false,
      changed: false,
      pointer: false,
      reloading: false,
      sentence: "live",
      view: "published",
      fading: false,
      status: { label: "Published", tone: "success", pending: false },
    });
  });

  it("types, saves, and publishes in order", () => {
    expect(order(frames.map(frame => frame.phase))).toEqual(["idle", "typing", "saving", "saved", "publishing", "published"]);
  });

  // The labels are the ones the Console editor header shows for an autosaved document.
  it("shows the Console status labels in order", () => {
    expect(order(frames.map(frame => frame.status.label))).toEqual(["Published", "Saving…", "Changed", "Publishing…", "Published"]);
    for (const frame of frames) expect(frame.status.pending).toBe(frame.status.label.endsWith("…"));
  });

  it("types one key at a time", () => {
    const lengths = order(frames.map(frame => frame.typed.length));
    expect(lengths).toEqual(Array.from({ length: cmsDemoSentence.length + 1 }, (_, count) => count));
  });

  it("shows the sentence on the draft after the save, and on the published page after publish", () => {
    expect(order(frames.map(frame => frame.sentence))).toEqual(["hidden", "draft", "live", "hidden"]);
    for (const frame of frames) {
      if (frame.sentence === "draft") expect(frame.view).toBe("draft");
      if (frame.sentence === "live") expect(frame).toMatchObject({ phase: "published", view: "published", typed: cmsDemoSentence });
    }
  });

  // The preview changes only after it reloads, and it reloads only after a save or a publish.
  it("reloads the preview before it shows the draft or the published page", () => {
    expect(order(frames.map(frame => frame.reloading))).toEqual([false, true, false, true, false]);
    const reloads = frames.filter((frame, index) => frame.reloading && !frames[index - 1]?.reloading);
    expect(reloads.map(frame => frame.phase)).toEqual(["saved", "published"]);
    for (const [index, frame] of frames.entries()) {
      const before = frames[index - 1];
      if (before && before.view !== frame.view) expect(before.reloading).toBe(true);
    }
  });

  // The loop starts where it ends, on the live post, so the only change at the restart is the new sentence going away.
  it("starts on the published page and turns to the draft only after the save", () => {
    expect(cmsDemoFrame(0).status).toEqual(cmsDemoFrame(cmsDemoEnd).status);
    expect(order(frames.map(frame => frame.view))).toEqual(["published", "draft", "published"]);
    const firstDraft = frames.find(frame => frame.view === "draft");
    expect(firstDraft).toMatchObject({ phase: "saved", sentence: "draft" });
  });

  it("enables Publish with the first key and disables it once the post is live", () => {
    expect(order(frames.map(frame => frame.changed))).toEqual([false, true, false]);
    expect(frames.find(frame => frame.changed)?.typed).toHaveLength(1);
    expect(frames.find(frame => frame.phase === "published")?.changed).toBe(false);
  });

  it("presses Publish only while the pointer is on it", () => {
    const pressed = frames.filter(frame => frame.pressed);
    expect(pressed.length).toBeGreaterThan(0);
    for (const frame of pressed) expect(frame.pointer).toBe(true);
    expect(cmsDemoFrame(cmsDemoEnd - cmsDemoCycle / 2).pressed).toBe(false);
  });

  it("fades out before the loop starts again", () => {
    expect(cmsDemoFrame(cmsDemoCycle - 1)).toMatchObject({ fading: true, sentence: "hidden" });
    expect(cmsDemoFrame(0)).toMatchObject({ typed: "", fading: false, sentence: "hidden", view: "published", changed: false });
  });
});
