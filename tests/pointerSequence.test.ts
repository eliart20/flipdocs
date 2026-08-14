import { describe, expect, it } from "vitest";
import { resolvePointerTurnPress } from "../src/core/pointerSequence";

describe("resolvePointerTurnPress", () => {
  it("starts a turn when no sheet is active", () => {
    expect(resolvePointerTurnPress(undefined, "next")).toBe("start");
  });

  it("lets a second trackpad press claim the same moving sheet", () => {
    expect(resolvePointerTurnPress("next", "next")).toBe("claim");
    expect(resolvePointerTurnPress("previous", "previous")).toBe("claim");
  });

  it("does not steal a sheet moving in the opposite direction", () => {
    expect(resolvePointerTurnPress("next", "previous")).toBe("reject");
    expect(resolvePointerTurnPress("previous", "next")).toBe("reject");
  });
});
