import type { FlipDirection } from "../types";

export type PointerTurnPress = "start" | "claim" | "reject";

/** Resolve a new press while a sheet may already be moving. */
export function resolvePointerTurnPress(
  activeDirection: FlipDirection | undefined,
  requestedDirection: FlipDirection,
): PointerTurnPress {
  if (!activeDirection) return "start";
  return activeDirection === requestedDirection ? "claim" : "reject";
}
