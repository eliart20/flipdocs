import { describe, expect, it } from "vitest";
import { turnShadingEnvelope } from "../src/core/pageMaterial";

describe("turnShadingEnvelope", () => {
  it("matches the resting page exactly at both flat endpoints", () => {
    expect(turnShadingEnvelope(0)).toBe(0);
    expect(turnShadingEnvelope(1)).toBe(0);
    expect(turnShadingEnvelope(-1)).toBe(0);
    expect(turnShadingEnvelope(2)).toBe(0);
  });

  it("keeps a shallow corner lift from introducing a dark step", () => {
    expect(turnShadingEnvelope(0.075)).toBeLessThan(0.06);
  });

  it("reaches full strength at mid-turn and is direction-symmetric", () => {
    expect(turnShadingEnvelope(0.5)).toBeCloseTo(1, 8);
    expect(turnShadingEnvelope(0.23)).toBeCloseTo(turnShadingEnvelope(0.77), 8);
  });
});
