import { describe, expect, it } from "vitest";
import { createRestingPageGeometry } from "../src/core/restingPageGeometry";

function edgeDepths(side: "left" | "right") {
  const geometry = createRestingPageGeometry(2, 3, side, 0.02);
  const positions = geometry.getAttribute("position");
  let left = Number.POSITIVE_INFINITY;
  let right = Number.POSITIVE_INFINITY;
  let centerNormalX = 0;
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    if (Math.abs(x + 1) < 0.0001) left = Math.min(left, positions.getZ(index));
    if (Math.abs(x - 1) < 0.0001) right = Math.min(right, positions.getZ(index));
    if (Math.abs(x) < 0.0001) {
      centerNormalX = Math.max(centerNormalX, Math.abs(geometry.getAttribute("normal").getX(index)));
    }
  }
  geometry.dispose();
  return { left, right, centerNormalX };
}

describe("createRestingPageGeometry", () => {
  it("bows only the inner edge of a left-hand page", () => {
    const { left, right } = edgeDepths("left");
    expect(left).toBeCloseTo(0, 6);
    expect(right).toBeCloseTo(0.04, 6);
  });

  it("mirrors the physical bend for a right-hand page", () => {
    const { left, right } = edgeDepths("right");
    expect(left).toBeCloseTo(0.04, 6);
    expect(right).toBeCloseTo(0, 6);
  });

  it("stays completely flat when resting bend is disabled", () => {
    const geometry = createRestingPageGeometry(2, 3, "right", 0);
    const positions = geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index += 1) {
      expect(positions.getZ(index)).toBeCloseTo(0, 8);
    }
    geometry.dispose();
  });
});
