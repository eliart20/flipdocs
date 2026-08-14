import { describe, expect, it } from "vitest";
import { attachedProgressForPointer } from "../src/core/pointerAttachment";

describe("attachedProgressForPointer", () => {
  it("tracks a loose edge whose book is stationary", () => {
    expect(attachedProgressForPointer({
      clientX: 260,
      initialSpineClientX: 200,
      initialSpineWorldX: 0,
      pagePixelWidth: 300,
      pageWorldWidth: 1,
      edgeWorldAtStart: 1,
      edgeWorldAtEnd: -1,
    })).toBeCloseTo(0.4, 6);
  });

  it("includes the mobile focus slide in the edge inverse", () => {
    // The spine begins at -0.46 world units while the loose edge travels from
    // +0.54 to -0.54. A cursor at +0.27 is exactly one quarter through that
    // complete path; solving against only the captured spine yields 0.135.
    expect(attachedProgressForPointer({
      clientX: 246,
      initialSpineClientX: 100,
      initialSpineWorldX: -0.46,
      pagePixelWidth: 200,
      pageWorldWidth: 1,
      edgeWorldAtStart: 0.54,
      edgeWorldAtEnd: -0.54,
    })).toBeCloseTo(0.25, 6);
  });
});
