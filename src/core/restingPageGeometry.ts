import { PlaneGeometry } from "three";

export type RestingPageSide = "left" | "right";

const smoothstep = (value: number) => value * value * (3 - 2 * value);

/** Shared sewn-binding shoulder used by both resting and turning sheets. */
export function pageBindingRise(
  width: number,
  height: number,
  distanceFromSpine: number,
  bend: number,
): number {
  const bendWidth = Math.max(width * 0.18, 0.0001);
  const depth = Math.max(0, bend) * Math.min(width, height);
  const normalized = Math.max(0, Math.min(1, distanceFromSpine / bendWidth));
  return depth * (1 - smoothstep(normalized));
}

/**
 * A resting page is not perfectly planar at the binding. This inexpensive
 * segmented sheet rises gently at the binding over its inner 18%, giving Three.js
 * real normals and real depth to light instead of relying on a screen-space
 * spine stripe.
 */
export function createRestingPageGeometry(
  width: number,
  height: number,
  side: RestingPageSide,
  bend = 0.018,
): PlaneGeometry {
  const geometry = new PlaneGeometry(width, height, 40, 2);
  const positions = geometry.getAttribute("position");
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const distanceFromSpine = side === "left"
      ? width * 0.5 - x
      : x + width * 0.5;
    // A shallow upward rise matches the shoulder formed by a sewn or glued
    // binding and gives the light a real surface normal to work with.
    positions.setZ(index, pageBindingRise(width, height, distanceFromSpine, bend));
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
