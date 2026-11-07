import { describe, expect, it } from "vitest";
import { cmsDemoCycle, cmsDemoEnd, cmsDemoFrame, cmsDemoSentence } from "../app/utils/cms-console-demo";

describe("CMS hero animation", () => {
  // The server and readers who turn motion off see this frame, so it must tell the whole story.
  it("ends on the published document", () => {
    expect(cmsDemoFrame(cmsDemoEnd)).toMatchObject({
      phase: "published",
      typed: cmsDemoSentence,
      published: true,
      fading: false,
      status: { label: "Published", tone: "success" },
    });
  });

  it("types, saves, and publishes in order", () => {
    const phases = Array.from({ length: cmsDemoCycle / 50 }, (_, step) => cmsDemoFrame(step * 50).phase);
    const order = phases.filter((phase, index) => phase !== phases[index - 1]);
    expect(order).toEqual(["idle", "typing", "saving", "saved", "publishing", "published"]);
  });

  it("shows the sentence on the site only after publish", () => {
    for (let time = 0; time < cmsDemoCycle; time += 50) {
      const frame = cmsDemoFrame(time);
      if (frame.published) expect(frame.typed).toBe(cmsDemoSentence);
    }
  });

  it("fades out before the loop starts again", () => {
    expect(cmsDemoFrame(cmsDemoCycle - 1)).toMatchObject({ fading: true, published: false });
    expect(cmsDemoFrame(0)).toMatchObject({ typed: "", fading: false, published: false });
  });
});
