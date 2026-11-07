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
      sentence: "live",
      banner: "live",
      fresh: false,
      fading: false,
      status: { label: "Published", tone: "success" },
    });
  });

  it("types, saves, and publishes in order", () => {
    expect(order(frames.map(frame => frame.phase))).toEqual(["idle", "typing", "saving", "saved", "publishing", "published"]);
  });

  it("types one key at a time", () => {
    const lengths = order(frames.map(frame => frame.typed.length));
    expect(lengths).toEqual(Array.from({ length: cmsDemoSentence.length + 1 }, (_, count) => count));
  });

  it("shows the sentence on the draft preview after the save, and on the live page after publish", () => {
    expect(order(frames.map(frame => frame.sentence))).toEqual(["hidden", "draft", "live", "hidden"]);
    for (const frame of frames) {
      if (frame.sentence === "draft") expect(frame.banner).toBe("draft");
      if (frame.sentence === "live") expect(frame).toMatchObject({ phase: "published", banner: "live", typed: cmsDemoSentence });
    }
  });

  // The loop starts where it ends, on the live post, so the only change at the restart is the new sentence going away.
  it("starts on the live post and turns to a draft only after the save", () => {
    expect(cmsDemoFrame(0).status).toEqual(cmsDemoFrame(cmsDemoEnd).status);
    expect(order(frames.map(frame => frame.banner))).toEqual(["live", "draft", "live"]);
    const firstDraft = frames.find(frame => frame.banner === "draft");
    expect(firstDraft).toMatchObject({ phase: "saved", sentence: "draft" });
  });

  it("wakes Publish with the first key and quiets it once the post is live", () => {
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
    expect(cmsDemoFrame(0)).toMatchObject({ typed: "", fading: false, sentence: "hidden", banner: "live", changed: false });
  });
});
