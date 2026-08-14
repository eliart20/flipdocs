import {
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from "three";
import type { FlipBookBodySettings } from "../types";

const SHEETS_PER_SIDE = 5;

export interface BookBodyState {
  pageWidth: number;
  pageHeight: number;
  /** Fraction of the book resting on the left side, from 0 to 1. */
  leftFraction: number;
  /** Fraction of the book still unread on the right side, from 0 to 1. */
  rightFraction: number;
  leftVisible: boolean;
  rightVisible: boolean;
  mobileMode: boolean;
}

/**
 * The closed mass of the book: fanned page-edge sheets behind each open page
 * and cover boards behind those. Everything here is a static unlit quad, so
 * the body adds draw calls but never adds per-frame work while the book idles.
 */
export class BookBody {
  readonly group = new Group();
  private settings: FlipBookBodySettings;
  private readonly paper: Color;
  private readonly leftSheets: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly rightSheets: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly leftBoard: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly rightBoard: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private state: BookBodyState = {
    pageWidth: 1,
    pageHeight: 1.4,
    leftFraction: 0,
    rightFraction: 1,
    leftVisible: false,
    rightVisible: true,
    mobileMode: false,
  };

  constructor(settings: FlipBookBodySettings, pageColor: string) {
    this.settings = { ...settings };
    this.paper = new Color(pageColor);
    for (let index = 0; index < SHEETS_PER_SIDE; index += 1) {
      const shade = this.paper.clone().multiplyScalar(1 - 0.045 * (index + 1));
      const left = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ color: shade }),
      );
      const right = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ color: shade.clone() }),
      );
      left.renderOrder = -1;
      right.renderOrder = -1;
      this.leftSheets.push(left);
      this.rightSheets.push(right);
      this.group.add(left, right);
    }
    const boardMaterial = new MeshBasicMaterial({ color: new Color(settings.coverColor) });
    this.leftBoard = new Mesh(new PlaneGeometry(1, 1), boardMaterial);
    this.rightBoard = new Mesh(new PlaneGeometry(1, 1), boardMaterial.clone());
    this.leftBoard.renderOrder = -2;
    this.rightBoard.renderOrder = -2;
    this.group.add(this.leftBoard, this.rightBoard);
    this.refresh();
  }

  setSettings(settings: FlipBookBodySettings): void {
    this.settings = { ...settings };
    const board = new Color(settings.coverColor);
    this.leftBoard.material.color.copy(board);
    this.rightBoard.material.color.copy(board);
    this.refresh();
  }

  update(state: Partial<BookBodyState>): void {
    this.state = { ...this.state, ...state };
    this.refresh();
  }

  private refresh(): void {
    const { pageWidth, pageHeight, mobileMode } = this.state;
    const visible = this.settings.enabled && !mobileMode;
    this.group.visible = visible;
    if (!visible) return;

    this.layoutSide(this.leftSheets, this.leftBoard, -1, this.state.leftFraction, this.state.leftVisible);
    this.layoutSide(this.rightSheets, this.rightBoard, 1, this.state.rightFraction, this.state.rightVisible);

    const overhang = this.settings.overhang * pageWidth;
    for (const board of [this.leftBoard, this.rightBoard]) {
      board.scale.y = pageHeight + overhang * 2;
    }
  }

  private layoutSide(
    sheets: Mesh<PlaneGeometry, MeshBasicMaterial>[],
    board: Mesh<PlaneGeometry, MeshBasicMaterial>,
    direction: -1 | 1,
    fraction: number,
    pageVisible: boolean,
  ): void {
    const { pageWidth, pageHeight } = this.state;
    // A nearly finished side still shows a sliver of stacked edges, matching
    // how a real book block never collapses to a single sheet.
    const effective = fraction <= 0 ? 0 : Math.max(0.14, Math.min(1, fraction));
    const stackWidth = this.settings.thickness * pageWidth * effective;
    const step = stackWidth / SHEETS_PER_SIDE;

    for (let index = 0; index < sheets.length; index += 1) {
      const sheet = sheets[index];
      const spread = step * (index + 1);
      sheet.visible = pageVisible && effective > 0;
      sheet.scale.set(pageWidth, pageHeight, 1);
      sheet.position.set(
        direction * (pageWidth / 2 + spread),
        -spread * 0.3,
        -0.004 * (index + 1),
      );
    }

    const overhang = this.settings.overhang * this.state.pageWidth;
    const boardWidth = pageWidth + stackWidth + overhang;
    board.visible = pageVisible;
    board.scale.x = boardWidth;
    board.position.set(
      direction * boardWidth / 2,
      -stackWidth * 0.3,
      -0.004 * (SHEETS_PER_SIDE + 1) - 0.002,
    );
  }

  dispose(): void {
    for (const sheet of [...this.leftSheets, ...this.rightSheets, this.leftBoard, this.rightBoard]) {
      sheet.geometry.dispose();
      sheet.material.dispose();
    }
    this.group.removeFromParent();
  }
}
