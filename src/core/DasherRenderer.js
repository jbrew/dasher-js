/**
 * DasherRenderer.js
 *
 * Pure rendering functions for the Dasher canvas.
 * Handles node rendering, crosshair, and cursor.
 */

import { ORIGIN_X, ORIGIN_Y } from "./DasherModel.js";
import { getNodeColor } from "./DasherView.js";

// Word color palette
const WORD_COLORS = [
  "#f5f5f5",
  "#a8d5e5",
  "#b5e5a8",
  "#e5d5a8",
  "#e5a8b5",
  "#d5a8e5",
];

export function getWordColor(colorIndex) {
  return WORD_COLORS[colorIndex % WORD_COLORS.length];
}

/**
 * Calculate opacity based on screen-space position.
 * Nodes fade as their left edge moves further past the crosshair.
 *
 * @param screenX - Node's left edge in screen coordinates
 * @param crosshairX - Crosshair X position in screen coordinates
 * @param decayFactor - Controls fade rate (0-1, higher = slower fade)
 */
export function getScreenSpaceOpacity(screenX, crosshairX, decayFactor) {
  const distancePastCrosshair = crosshairX - screenX;

  if (distancePastCrosshair <= 0) {
    return 1;
  }

  const fadeScale = crosshairX * 0.5;
  const normalizedDistance = distancePastCrosshair / fadeScale;

  return Math.pow(decayFactor, normalizedDistance);
}

/**
 * Main render function for the Dasher canvas
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {DasherModel} model
 * @param {DasherView} view
 * @param {{width: number, height: number}} dimensions
 * @param {Object} settings - Rendering settings
 * @param {number} settings.minNodeSize - Min node height in pixels (default 2)
 * @param {number} settings.expansionThreshold - Min node height to pre-expand (default 40)
 * @param {number} settings.opacityDecay - Opacity decay factor (default 0.8)
 * @param {string} settings.mode - "word" or "character" (default "character")
 * @param {{x: number, y: number, active: boolean}} mouse
 * @param {boolean} isPaused
 */
export function render(ctx, model, view, dimensions, settings, mouse, isPaused) {
  const { width, height } = dimensions;

  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(0, 0, width, height);

  if (!model.root) return;

  const items = view.collectRenderNodes(
    model,
    settings.minNodeSize ?? 2,
    settings.expansionThreshold ?? 40
  );

  const opacityDecay = settings.opacityDecay ?? 0.8;
  const crosshairScreen = view.dasher2Screen(ORIGIN_X, ORIGIN_Y);

  for (const item of items) {
    const opacity = getScreenSpaceOpacity(item.screenX, crosshairScreen.x, opacityDecay);

    if (settings.mode === "word") {
      renderWordNode(ctx, item, view, settings, opacity);
    } else {
      renderCharNode(ctx, item, view, opacity);
    }
  }

  renderCrosshair(ctx, view, height, width);

  if (mouse && mouse.active && !isPaused) {
    renderCursor(ctx, mouse, crosshairScreen);
  }
}

/**
 * Draw the crosshair at the origin point
 */
export function renderCrosshair(ctx, view, height, width) {
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;

  const crosshairScreen = view.dasher2Screen(ORIGIN_X, ORIGIN_Y);

  ctx.beginPath();
  ctx.moveTo(crosshairScreen.x, 0);
  ctx.lineTo(crosshairScreen.x, height);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, crosshairScreen.y);
  ctx.lineTo(width, crosshairScreen.y);
  ctx.stroke();

  ctx.fillStyle = "#333";
  ctx.beginPath();
  ctx.arc(crosshairScreen.x, crosshairScreen.y, 5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw a dotted line from the crosshair to the mouse cursor, with a dot at the cursor
 */
export function renderCursor(ctx, mouse, crosshairScreen) {
  ctx.strokeStyle = "#ff6600";
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(crosshairScreen.x, crosshairScreen.y);
  ctx.lineTo(mouse.x, mouse.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#ff6600";
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 6, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Render a character node
 */
export function renderCharNode(ctx, item, view, opacity = 1) {
  const { node, screenX, screenY1, screenY2, screenWidth, coversCrosshair } = item;
  const height = screenY2 - screenY1;

  if (height < 1) return;

  ctx.globalAlpha = opacity;
  const color = getNodeColor(node.color || 0);
  ctx.fillStyle = color;
  ctx.fillRect(screenX, screenY1, screenWidth, height);

  ctx.globalAlpha = 1;
  ctx.strokeStyle = coversCrosshair ? "#000" : "#999";
  ctx.lineWidth = coversCrosshair ? 2 : 1;
  ctx.strokeRect(screenX, screenY1, screenWidth, height);

  if (height > 20 && node.token) {
    ctx.globalAlpha = opacity;
    ctx.fillStyle = "#000";
    ctx.font = `${Math.min(height * 0.7, 24)}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const text = node.token === " " ? "\u2423" : node.token;
    const textX = screenX + 5;
    const textY = (screenY1 + screenY2) / 2;

    if (textX < view.width) {
      ctx.fillText(text, textX, textY);
    }
  }

  ctx.globalAlpha = 1;
}

/**
 * Render a word node
 */
export function renderWordNode(ctx, item, view, settings = {}, opacity = 1) {
  const { node, screenX, screenY1, screenY2, screenWidth, coversCrosshair } = item;
  const height = screenY2 - screenY1;

  if (height < 1) return;

  ctx.globalAlpha = opacity;
  const color = getWordColor(node.color || 0);
  ctx.fillStyle = color;
  ctx.fillRect(screenX, screenY1, screenWidth, height);

  ctx.globalAlpha = 1;
  ctx.strokeStyle = coversCrosshair ? "#000" : "#999";
  ctx.lineWidth = coversCrosshair ? 2 : 1;
  ctx.strokeRect(screenX, screenY1, screenWidth, height);

  ctx.globalAlpha = opacity;
  const text = node.token || "";

  if (height > 15 && text) {
    ctx.fillStyle = "#000";

    const maxFontSize = Math.min(height * 0.6, 24);
    const minFontSize = 10;
    let fontSize = maxFontSize;

    ctx.font = `${fontSize}px sans-serif`;
    let textWidth = ctx.measureText(text).width;

    const maxTextWidth = screenWidth - 10;
    while (textWidth > maxTextWidth && fontSize > minFontSize) {
      fontSize -= 1;
      ctx.font = `${fontSize}px sans-serif`;
      textWidth = ctx.measureText(text).width;
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const textX = screenX + 5;
    const textY = (screenY1 + screenY2) / 2;

    if (textX < view.width && fontSize >= minFontSize) {
      ctx.fillText(text, textX, textY);
    }
  }

  ctx.globalAlpha = 1;
}
