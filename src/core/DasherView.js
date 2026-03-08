/**
 * DasherView.js
 *
 * Handles coordinate transformations between screen space and Dasher space,
 * and collects nodes for rendering. Based on DasherViewSquare.cpp from
 * the original implementation.
 *
 * Key insight: The screen coordinate system uses a FIXED reference point
 * (ORIGIN_Y = 2048 for vertical center). This is what allows nodes to
 * appear to move on screen as we zoom - their Dasher coordinates change
 * relative to this fixed reference.
 */

import { ORIGIN_X, ORIGIN_Y, MAX_Y, NORMALIZATION } from './DasherModel.js';

/**
 * Manages the view/rendering of the Dasher model
 */
export class DasherView {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} crosshairRatio - Internal scale ratio for crosshair X positioning.
   *   Higher values push the crosshair LEFT on screen, giving more room for
   *   already-selected content on the right. Lower values push it RIGHT,
   *   giving more room for upcoming content on the left.
   *   Default 0.75 (crosshair at 25% from left). Mobile: 0.4 (crosshair at 60%).
   */
  constructor(width, height, crosshairRatio = 0.75) {
    this.width = width;
    this.height = height;
    this.crosshairRatio = crosshairRatio;
    this.updateScaleFactors();
  }

  /**
   * Update dimensions and recalculate scale factors
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.updateScaleFactors();
  }

  /**
   * Calculate scale factors for coordinate transformation.
   */
  updateScaleFactors() {
    this.scaleFactorY = this.height / MAX_Y;

    const crosshairScreenX = this.width * this.crosshairRatio;
    this.scaleFactorX = crosshairScreenX / ORIGIN_X;

    this.crosshairX = crosshairScreenX;
    this.crosshairY = this.height / 2;
  }

  /**
   * Convert screen coordinates to Dasher coordinates.
   */
  screen2Dasher(screenX, screenY) {
    const dasherX = (this.width - screenX) / this.scaleFactorX;
    const dasherY = ORIGIN_Y + (screenY - this.height / 2) / this.scaleFactorY;
    return { x: dasherX, y: dasherY };
  }

  /**
   * Convert Dasher coordinates to screen coordinates.
   */
  dasher2Screen(dasherX, dasherY) {
    const screenX = this.width - dasherX * this.scaleFactorX;
    const screenY = this.height / 2 + (dasherY - ORIGIN_Y) * this.scaleFactorY;
    return { x: screenX, y: screenY };
  }

  /**
   * Get the visible region in Dasher coordinates
   */
  getVisibleRegion() {
    const topLeft = this.screen2Dasher(0, 0);
    const bottomRight = this.screen2Dasher(this.width, this.height);

    return {
      minX: bottomRight.x,
      maxX: topLeft.x,
      minY: topLeft.y,
      maxY: bottomRight.y
    };
  }

  /**
   * Collect all nodes that should be rendered, with their screen coordinates.
   *
   * @param model - The DasherModel instance
   * @param minNodeSize - Minimum node height in pixels to render
   * @param expansionThreshold - Minimum node height in pixels to pre-expand children
   * @returns Array of render items: { node, screenY1, screenY2, screenX }
   */
  collectRenderNodes(model, minNodeSize = 2, expansionThreshold = 40) {
    const items = [];
    const visible = this.getVisibleRegion();

    this._collectNodes(
      model,
      model.root,
      model.rootmin,
      model.rootmax,
      items,
      visible,
      minNodeSize,
      expansionThreshold
    );

    return items;
  }

  _collectNodes(model, node, dasherY1, dasherY2, items, visible, minNodeSize, expansionThreshold) {
    if (dasherY2 < visible.minY || dasherY1 > visible.maxY) {
      return null;
    }

    const range = dasherY2 - dasherY1;
    const dasherX = range;

    if (dasherX < visible.minX) {
      return null;
    }

    const screen1 = this.dasher2Screen(dasherX, dasherY1);
    const screen2 = this.dasher2Screen(0, dasherY2);

    const screenHeight = screen2.y - screen1.y;

    if (screenHeight < minNodeSize) {
      return null;
    }

    const item = {
      node,
      screenX: screen1.x,
      screenY1: screen1.y,
      screenY2: screen2.y,
      screenWidth: screen2.x - screen1.x,
      dasherY1,
      dasherY2,
      coversCrosshair: model.coversCrosshair(dasherY1, dasherY2)
    };
    items.push(item);

    if (!node.children && screenHeight > expansionThreshold) {
      model.expandNode(node);
    }

    let onlyChildRendered = null;
    let renderedChildCount = 0;

    if (node.children) {
      for (const child of node.children) {
        const childBounds = model.getNodeDasherBounds(child, dasherY1, dasherY2);

        const childResult = this._collectNodes(
          model,
          child,
          childBounds.y1,
          childBounds.y2,
          items,
          visible,
          minNodeSize,
          expansionThreshold
        );

        if (childResult !== null) {
          renderedChildCount++;
          onlyChildRendered = child;
        }
      }
    }

    if (renderedChildCount === 1) {
      node.onlyChildRendered = onlyChildRendered;
    } else {
      node.onlyChildRendered = null;
    }

    return item;
  }

  /**
   * Check if there's space around a node (used for reparenting decision)
   */
  isSpaceAroundNode(dasherY1, dasherY2) {
    const visible = this.getVisibleRegion();
    const range = dasherY2 - dasherY1;

    return range < visible.maxX ||
           dasherY1 > visible.minY ||
           dasherY2 < visible.maxY;
  }
}

/**
 * Color palette for rendering nodes
 */
export const COLORS = [
  '#FFFFFF',  // 0: white (space)
  '#FFE4E1',  // 1: light pink (vowels)
  '#E0FFFF',  // 2: light cyan (consonants)
  '#F0FFF0',  // 3: honeydew
  '#FFF0F5',  // 4: lavender blush
  '#F5FFFA',  // 5: mint cream
  '#FFFAF0',  // 6: floral white
  '#F0F8FF',  // 7: alice blue
];

/**
 * Get a color for a node based on its color index and depth
 */
export function getNodeColor(colorIndex, depth = 0) {
  const baseColor = COLORS[colorIndex % COLORS.length];
  if (depth % 2 === 0) {
    return baseColor;
  }
  return adjustBrightness(baseColor, -10);
}

function adjustBrightness(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000FF) + percent));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export default DasherView;
