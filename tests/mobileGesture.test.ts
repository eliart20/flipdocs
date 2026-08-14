import { describe, expect, it } from "vitest";
import {
  mobileGestureIntent,
  mobileHeldGestureIntent,
} from "../src/core/mobileGesture";

describe("mobileGestureIntent", () => {
  it("keeps the hold timer from promoting an inner-half gesture to direct drag", () => {
    expect(mobileHeldGestureIntent(0.49)).toBe("flick");
    expect(mobileHeldGestureIntent(0.5)).toBe("drag");
  });

  it("always assigns the inner half to the canonical flick", () => {
    expect(mobileGestureIntent({
      grabX: 0.22,
      horizontalDistance: 9,
      verticalDistance: 0,
      elapsedMs: 420,
    })).toBe("flick");
  });

  it("starts a quick outer-half movement as direct manipulation immediately", () => {
    expect(mobileGestureIntent({
      grabX: 0.82,
      horizontalDistance: 34,
      verticalDistance: 2,
      elapsedMs: 54,
    })).toBe("drag");
  });

  it("assigns a held outer-half movement to direct manipulation", () => {
    expect(mobileGestureIntent({
      grabX: 0.82,
      horizontalDistance: 14,
      verticalDistance: 3,
      elapsedMs: 210,
    })).toBe("drag");
  });

  it("does not wait for the old hold threshold on the outer half", () => {
    expect(mobileGestureIntent({
      grabX: 0.82,
      horizontalDistance: 8,
      verticalDistance: 1,
      elapsedMs: 12,
    })).toBe("drag");
  });

  it("waits while intent is still ambiguous", () => {
    expect(mobileGestureIntent({
      grabX: 0.82,
      horizontalDistance: 5,
      verticalDistance: 1,
      elapsedMs: 300,
    })).toBe("pending");
  });
});
