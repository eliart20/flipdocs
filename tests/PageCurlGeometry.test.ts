import { describe, expect, it } from "vitest";
import { PageCurlGeometry } from "../src/core/PageCurlGeometry";

function position(geometry: PageCurlGeometry, index: number) {
  const attribute = geometry.getAttribute("position");
  return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)];
}

function maximumEdgeStretch(
  geometry: PageCurlGeometry,
  xSegments: number,
  ySegments: number,
  width: number,
  height: number,
) {
  const positions = geometry.getAttribute("position");
  const edgeLength = (a: number, b: number) => Math.hypot(
    positions.getX(b) - positions.getX(a),
    positions.getY(b) - positions.getY(a),
    positions.getZ(b) - positions.getZ(a),
  );
  let maximum = 1;
  for (let row = 0; row <= ySegments; row += 1) {
    for (let column = 0; column <= xSegments; column += 1) {
      const vertex = row * (xSegments + 1) + column;
      if (column < xSegments) {
        maximum = Math.max(maximum, edgeLength(vertex, vertex + 1) / (width / xSegments));
      }
      if (row < ySegments) {
        maximum = Math.max(
          maximum,
          edgeLength(vertex, vertex + xSegments + 1) / (height / ySegments),
        );
      }
    }
  }
  return maximum;
}

describe("PageCurlGeometry", () => {
  it("lies flat on the right at the start", () => {
    const geometry = new PageCurlGeometry(8, 2);
    geometry.update(2, 3, 0);
    const [x, , z] = position(geometry, 8);
    expect(x).toBeCloseTo(2, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it("lies flat on the left at the end", () => {
    const geometry = new PageCurlGeometry(8, 2);
    geometry.update(2, 3, 1);
    const [x, , z] = position(geometry, 8);
    expect(x).toBeCloseTo(-2, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it("rises out of the book at mid-flip", () => {
    const geometry = new PageCurlGeometry(16, 4);
    geometry.update(2, 3, 0.5);
    const positions = geometry.getAttribute("position");
    let maxZ = 0;
    for (let index = 0; index < positions.count; index += 1) {
      maxZ = Math.max(maxZ, positions.getZ(index));
    }
    expect(maxZ).toBeGreaterThan(0.05);
  });

  it("moves the grabbed top edge toward a lower pointer", () => {
    const geometry = new PageCurlGeometry(16, 4);
    geometry.update(2, 3, 0.5, { grabX: 1, grabY: 1, targetY: 0.25 });
    const outerTop = position(geometry, 4 * 17 + 16);
    expect(outerTop[1]).toBeLessThan(1);
  });

  it("moves the grabbed bottom edge toward a higher pointer", () => {
    const geometry = new PageCurlGeometry(16, 4);
    geometry.update(2, 3, 0.5, { grabX: 1, grabY: 0, targetY: 0.75 });
    const outerBottom = position(geometry, 16);
    expect(outerBottom[1]).toBeGreaterThan(-1);
  });

  it("places a directly attached edge point exactly at the pointer projection", () => {
    const geometry = new PageCurlGeometry(16, 4);
    geometry.update(2, 3, 0.4, {
      grabX: 1,
      grabY: 0.75,
      targetY: 0.35,
      pointerAttached: true,
    });
    const grabbedEdge = position(geometry, 3 * 17 + 16);
    expect(grabbedEdge[0]).toBeCloseTo(0.4, 5);
    expect(grabbedEdge[1]).toBeCloseTo(-0.45, 5);
  });

  it("is reversible when the pointer moves back", () => {
    const interaction = { grabX: 0.72, grabY: 0.86, targetY: 0.44 };
    const backtracked = new PageCurlGeometry(16, 4);
    backtracked.update(2, 3, 0.78, interaction);
    backtracked.update(2, 3, 0.31, interaction);
    const fresh = new PageCurlGeometry(16, 4);
    fresh.update(2, 3, 0.31, interaction);

    const backtrackedOuter = position(backtracked, 2 * 17 + 16);
    const freshOuter = position(fresh, 2 * 17 + 16);
    expect(backtrackedOuter).toEqual(freshOuter);
  });

  it("keeps every spine vertex attached", () => {
    const geometry = new PageCurlGeometry(24, 16);
    geometry.update(2, 3, 0.47, { grabX: 0.88, grabY: 0.92, targetY: 0.18 });
    const positions = geometry.getAttribute("position");
    for (let row = 0; row <= 16; row += 1) {
      const vertex = row * 25;
      expect(positions.getX(vertex)).toBe(0);
      expect(positions.getZ(vertex)).toBe(0);
      expect(positions.getY(vertex)).toBeCloseTo((row / 16 - 0.5) * 3, 6);
    }
  });

  it("shares the resting binding shoulder without lifting the loose edge", () => {
    const geometry = new PageCurlGeometry(20, 4);
    const flatBinding = new PageCurlGeometry(20, 4);
    const interaction = { grabX: 1, grabY: 0, targetY: 0.08 };
    geometry.update(
      2,
      3,
      0.075,
      interaction,
      undefined,
      false,
      0.04,
    );
    flatBinding.update(2, 3, 0.075, interaction);
    const positions = geometry.getAttribute("position");
    const flatPositions = flatBinding.getAttribute("position");
    for (let row = 0; row <= 4; row += 1) {
      const spine = row * 21;
      expect(positions.getZ(spine)).toBeCloseTo(0.08, 6);
    }
    expect(positions.getZ(20)).toBeCloseTo(flatPositions.getZ(20), 6);
  });

  it("bounds local stretch for a low near-spine grab pulled high", () => {
    const xSegments = 72;
    const ySegments = 64;
    const width = 1.4;
    const height = 2;
    const geometry = new PageCurlGeometry(xSegments, ySegments);
    geometry.update(
      width,
      height,
      0.52,
      { grabX: 0.12, grabY: 0.08, targetY: 0.92 },
      {
        radius: 0.16,
        radiusLimit: 0.65,
        verticalPull: 0.65,
        binding: 0.14,
        dragResistance: 1,
        snapThreshold: 0.24,
      },
    );
    const stretch = maximumEdgeStretch(geometry, xSegments, ySegments, width, height);
    expect(stretch).toBeLessThan(1.4);
  });

  it("spreads a large diagonal corner sweep instead of forming a spine neck", () => {
    const xSegments = 72;
    const ySegments = 64;
    const width = 1.4;
    const height = 2;
    const geometry = new PageCurlGeometry(xSegments, ySegments);
    geometry.update(
      width,
      height,
      0.52,
      { grabX: 0.75, grabY: 0.08, targetY: 0.92 },
      {
        radius: 0.16,
        radiusLimit: 0.65,
        verticalPull: 0.65,
        binding: 0.14,
        dragResistance: 1,
        snapThreshold: 0.24,
      },
    );
    expect(maximumEdgeStretch(geometry, xSegments, ySegments, width, height))
      .toBeLessThan(1.5);
  });
});

describe("mirrored previous-page curl", () => {
  it("is the exact horizontal mirror of a fresh right-page curl", () => {
    const forward = new PageCurlGeometry(18, 12);
    const previous = new PageCurlGeometry(18, 12);
    const interaction = { grabX: 0.86, grabY: 0.22, targetY: 0.58 };
    const settings = {
      radius: 0.16,
      radiusLimit: 0.65,
      verticalPull: 0.65,
      binding: 0.14,
      dragResistance: 1,
      snapThreshold: 0.24,
    };

    forward.update(1.4, 2, 0.36, interaction, settings);
    previous.update(1.4, 2, 0.36, interaction, settings, true);
    const forwardPositions = forward.getAttribute("position").array;
    const previousPositions = previous.getAttribute("position").array;

    for (let index = 0; index < forwardPositions.length; index += 3) {
      expect(previousPositions[index]).toBeCloseTo(-forwardPositions[index], 5);
      expect(previousPositions[index + 1]).toBeCloseTo(forwardPositions[index + 1], 5);
      expect(previousPositions[index + 2]).toBeCloseTo(forwardPositions[index + 2], 5);
    }
  });
});
