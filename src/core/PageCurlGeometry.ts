import { BufferAttribute, BufferGeometry } from "three";
import type { FlipBookCurlSettings } from "../types";
import { pageBindingRise } from "./restingPageGeometry";

/** The subset of curl settings the sheet geometry itself consumes. */
export type PageCurlPhysics = Pick<
  FlipBookCurlSettings,
  "radius" | "radiusLimit" | "verticalPull" | "binding" | "dragResistance" | "snapThreshold"
>;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface PageCurlInteraction {
  /** Horizontal grab point, where 0 is the spine and 1 is the loose edge. */
  grabX: number;
  /** Vertical grab point, where 0 is the bottom and 1 is the top. */
  grabY: number;
  /** Current pointer destination in the same bottom-to-top coordinates. */
  targetY: number;
  /** Prioritize the live pointer position over the authored vertical feel. */
  pointerAttached?: boolean;
}

/** The most recent fold line, in the curl mesh's local space (mirror applied). */
export interface FoldState {
  active: boolean;
  axisX: number;
  axisY: number;
  normalX: number;
  normalY: number;
  radius: number;
}

/** A low-vertex, developable paper sheet. Only this geometry changes during a flip. */
export class PageCurlGeometry extends BufferGeometry {
  readonly fold: FoldState = {
    active: false,
    axisX: 0,
    axisY: 0,
    normalX: 1,
    normalY: 0,
    radius: 0,
  };

  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;

  /** Horizontal segment count this sheet was built with. */
  get segmentCountX(): number {
    return this.xSegments;
  }

  constructor(
    private readonly xSegments = 72,
    private readonly ySegments = 64,
  ) {
    super();
    const vertexCount = (xSegments + 1) * (ySegments + 1);
    this.positions = new Float32Array(vertexCount * 3);
    this.uvs = new Float32Array(vertexCount * 2);
    const indices: number[] = [];

    for (let y = 0; y <= ySegments; y += 1) {
      for (let x = 0; x <= xSegments; x += 1) {
        const vertex = y * (xSegments + 1) + x;
        this.uvs[vertex * 2] = x / xSegments;
        this.uvs[vertex * 2 + 1] = y / ySegments;
      }
    }

    for (let y = 0; y < ySegments; y += 1) {
      for (let x = 0; x < xSegments; x += 1) {
        const a = y * (xSegments + 1) + x;
        const b = a + 1;
        const c = a + xSegments + 1;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }

    this.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.setAttribute("uv", new BufferAttribute(this.uvs, 2));
    this.setIndex(indices);
    this.update(1, 1.4, 0);
  }

  update(
    width: number,
    height: number,
    rawProgress: number,
    interaction: PageCurlInteraction = { grabX: 1, grabY: 0.78, targetY: 0.52 },
    physics: PageCurlPhysics = {
      radius: 0.16,
      radiusLimit: 0.65,
      verticalPull: 0.65,
      binding: 0.14,
      dragResistance: 1,
      snapThreshold: 0.22,
    },
    mirrorX = false,
    bindingBend = 0,
  ): void {
    const progress = clamp01(rawProgress);
    const grabX = clamp01(interaction.grabX);
    const grabY = clamp01(interaction.grabY);
    const targetY = clamp01(interaction.targetY);

    if (progress <= 0.000001) {
      this.fold.active = false;
      this.writeFlat(width, height, mirrorX ? -1 : 1, bindingBend);
      return;
    }
    if (progress >= 0.999999) {
      this.fold.active = false;
      this.writeFlat(width, height, mirrorX ? 1 : -1, bindingBend);
      return;
    }

    // Material-space position of the point the reader picked up. The target
    // follows the pointer: horizontally it mirrors through the spine as the
    // turn goes 0 -> 1; vertically it uses the live pointer coordinate.
    const originX = Math.max(width * 0.02, grabX * width);
    const originY = (grabY - 0.5) * height;
    const targetX = originX * (1 - 2 * progress);
    // Vertical pull fades at the two flat endpoints, avoiding a last-frame
    // snap when a diagonal drag settles onto the book. A point close to the
    // fixed spine also has very little material length available for vertical
    // travel. Clamp the requested projection so the grabbed point, including
    // the curl height, remains within its inextensible reach from the spine.
    const curlEnvelope = Math.sin(Math.PI * progress);
    const verticalTracking = interaction.pointerAttached
      ? 1
      : physics.verticalPull * curlEnvelope;
    const requestedDeltaY = (targetY - grabY) * height * verticalTracking;
    const baseBinding = Math.max(0.01, Math.min(0.9, physics.binding));
    const maximumBinding = Math.max(baseBinding, 0.7);
    const diagonalSweep = Math.abs(targetY - grabY) * curlEnvelope;
    const effectiveBinding =
      baseBinding + (maximumBinding - baseBinding) * diagonalSweep;
    const desiredRadius = width * physics.radius * curlEnvelope;
    const candidateRadius = (distance: number) => Math.min(
      desiredRadius,
      (distance / Math.PI) * physics.radiusLimit,
    );
    const horizontalDrag = originX - targetX;
    // Attachment wins over the preferred curl radius. If the pointer's x/y
    // projection is reachable by the sheet, keep it exact and allow the
    // cylinder radius below to shrink to the remaining 3D chord budget.
    const withinMaterialReach = (deltaY: number) =>
      targetX * targetX + deltaY * deltaY <= originX * originX + 0.000001;
    let constrainedDeltaY = requestedDeltaY;
    if (!withinMaterialReach(constrainedDeltaY)) {
      const sign = Math.sign(constrainedDeltaY);
      let low = 0;
      let high = Math.abs(constrainedDeltaY);
      if (withinMaterialReach(0)) {
        for (let iteration = 0; iteration < 14; iteration += 1) {
          const middle = (low + high) * 0.5;
          if (withinMaterialReach(sign * middle)) low = middle;
          else high = middle;
        }
      }
      constrainedDeltaY = sign * low;
    }
    const targetYWorld = originY + constrainedDeltaY;
    const dragX = originX - targetX;
    const dragY = originY - targetYWorld;
    const dragDistance = Math.hypot(dragX, dragY);

    if (dragDistance < 0.00001) return;

    // n points from the pointer toward the original grab point; tangent runs
    // along the fold. This makes the fold axis respond to both X and Y drag.
    const nx = dragX / dragDistance;
    const ny = dragY / dragDistance;
    const tx = -ny;
    const ty = nx;

    // A half-cylinder is an isometric (length-preserving) paper bend. Radius
    // grows in the middle of the gesture and collapses at both flat endpoints.
    // The D / PI bound guarantees the grabbed point lies beyond the curl band,
    // which prevents the band from folding through itself.
    const reachRadius = 0.5 * Math.sqrt(Math.max(
      0,
      originX * originX - targetX * targetX - constrainedDeltaY * constrainedDeltaY,
    ));
    const radius = Math.max(
      0.0001,
      Math.min(candidateRadius(dragDistance), reachRadius),
    );
    const arcLength = Math.PI * radius;

    // Solving 2*sOrigin = D + PI*r places the cylinder so the original grab
    // point lands at the pointer after the flat turned section is reflected.
    const midpointX = (originX + targetX) * 0.5;
    const midpointY = (originY + targetYWorld) * 0.5;
    const axisX = midpointX - nx * arcLength * 0.5;
    const axisY = midpointY - ny * arcLength * 0.5;

    // Publish the fold line so the engine can shade the pages beside it.
    this.fold.active = true;
    this.fold.axisX = mirrorX ? -axisX : axisX;
    this.fold.axisY = axisY;
    this.fold.normalX = mirrorX ? -nx : nx;
    this.fold.normalY = ny;
    this.fold.radius = radius;

    for (let row = 0; row <= this.ySegments; row += 1) {
      const v = row / this.ySegments;
      const flatY = (v - 0.5) * height;

      // Evaluate the unconstrained curl at this row's spine point once. The
      // attachment zone removes only that boundary displacement; it does not
      // scale the page's entire deformation down to zero. This avoids forcing
      // a diagonal drag through a narrow, visibly stretched "neck".
      const spineRelativeX = -axisX;
      const spineRelativeY = flatY - axisY;
      const spineNormalDistance = spineRelativeX * nx + spineRelativeY * ny;
      const spineTangentDistance = spineRelativeX * tx + spineRelativeY * ty;
      let spineMappedNormal = spineNormalDistance;
      let spineZ = 0;
      if (spineNormalDistance > 0 && spineNormalDistance < arcLength) {
        const spineAngle = spineNormalDistance / radius;
        spineMappedNormal = radius * Math.sin(spineAngle);
        spineZ = radius * (1 - Math.cos(spineAngle));
      } else if (spineNormalDistance >= arcLength) {
        spineMappedNormal = -(spineNormalDistance - arcLength);
        spineZ = radius * 2;
      }
      const spineMappedX =
        axisX + nx * spineMappedNormal + tx * spineTangentDistance;
      const spineMappedY =
        axisY + ny * spineMappedNormal + ty * spineTangentDistance;
      const spineDisplacementY = spineMappedY - flatY;

      for (let column = 0; column <= this.xSegments; column += 1) {
        const u = column / this.xSegments;
        const flatX = u * width;
        const relativeX = flatX - axisX;
        const relativeY = flatY - axisY;
        const normalDistance = relativeX * nx + relativeY * ny;
        const tangentDistance = relativeX * tx + relativeY * ty;
        let mappedNormal = normalDistance;
        let zPosition = 0;

        if (normalDistance > 0 && normalDistance < arcLength) {
          const angle = normalDistance / radius;
          mappedNormal = radius * Math.sin(angle);
          zPosition = radius * (1 - Math.cos(angle));
        } else if (normalDistance >= arcLength) {
          mappedNormal = -(normalDistance - arcLength);
          zPosition = radius * 2;
        }

        const xPosition = axisX + nx * mappedNormal + tx * tangentDistance;
        const yPosition = axisY + ny * mappedNormal + ty * tangentDistance;
        const vertex = row * (this.xSegments + 1) + column;
        const offset = vertex * 3;
        // A book page is fixed along its entire spine. Fade out only the
        // unconstrained spine displacement over the stiffness zone, leaving
        // the curl itself intact and approximately length preserving.
        const bindingT = clamp01(u / effectiveBinding);
        const smoothBinding = bindingT * bindingT * (3 - 2 * bindingT);
        const boundaryCorrection = 1 - smoothBinding;
        const attachedX = xPosition - spineMappedX * boundaryCorrection;
        this.positions[offset] = mirrorX ? -attachedX : attachedX;
        this.positions[offset + 1] =
          yPosition - spineDisplacementY * boundaryCorrection;
        // The live sheet shares the same binding shoulder as the resting
        // sheet beneath it. Without this profile, a strongly bowed under-page
        // can poke through beside the spine during a shallow corner preview.
        this.positions[offset + 2] =
          zPosition - spineZ * boundaryCorrection +
          pageBindingRise(width, height, u * width, bindingBend);
      }
    }

    this.commitPositions();
  }

  private writeFlat(
    width: number,
    height: number,
    direction: 1 | -1,
    bindingBend: number,
  ): void {
    for (let row = 0; row <= this.ySegments; row += 1) {
      for (let column = 0; column <= this.xSegments; column += 1) {
        const vertex = row * (this.xSegments + 1) + column;
        const offset = vertex * 3;
        this.positions[offset] = direction * (column / this.xSegments) * width;
        this.positions[offset + 1] = (row / this.ySegments - 0.5) * height;
        this.positions[offset + 2] = pageBindingRise(
          width,
          height,
          (column / this.xSegments) * width,
          bindingBend,
        );
      }
    }
    this.commitPositions();
  }

  private commitPositions(): void {
    const position = this.getAttribute("position") as BufferAttribute;
    position.needsUpdate = true;
    this.computeVertexNormals();
    this.computeBoundingSphere();
  }
}
