/**
 * DasherCanvas.jsx
 *
 * Minimal Dasher canvas component. Handles:
 * - Canvas rendering via requestAnimationFrame
 * - Mouse and touch input
 * - Pause/unpause on click
 *
 * No UI chrome, no settings panels, no source loading.
 *
 * Usage:
 *   <DasherCanvas
 *     modelRef={modelRef}
 *     viewRef={viewRef}
 *     modelReady={modelReady}
 *     settings={{ mode: "character", zoomSpeed: 12 }}
 *   />
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { render } from "../core/DasherRenderer.js";

const FRAME_RATE = 60;
const FRAME_INTERVAL = 1000 / FRAME_RATE;

const DEFAULT_SETTINGS = {
  mode: "character",
  zoomSpeed: 12,
  minNodeSize: 2,
  expansionThreshold: 40,
  opacityDecay: 0.8,
};

export function DasherCanvas({
  modelRef,
  viewRef,
  modelReady,
  settings: propSettings = {},
  width: propWidth,
  height: propHeight,
  className = "",
  onPauseChange,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0, active: false });
  const animationRef = useRef(null);
  const lastFrameRef = useRef(0);

  const [dimensions, setDimensions] = useState({
    width: propWidth || 800,
    height: propHeight || 600,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(true);

  const settings = { ...DEFAULT_SETTINGS, ...propSettings };

  // Resize observer
  useEffect(() => {
    if (propWidth && propHeight) return; // Fixed dimensions, skip observer

    const updateDimensions = () => {
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        if (w > 0 && h > 0) {
          setDimensions({ width: w, height: h });
          viewRef.current?.resize(w, h);
        }
      }
    };

    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    updateDimensions();

    return () => observer.disconnect();
  }, [propWidth, propHeight]);

  // Animation loop
  const animate = useCallback(
    (timestamp) => {
      if (!modelRef.current || !viewRef.current || !canvasRef.current) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      if (timestamp - lastFrameRef.current < FRAME_INTERVAL) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }
      lastFrameRef.current = timestamp;

      const model = modelRef.current;
      const view = viewRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");

      if (mouseRef.current.active && isRunning && !isPaused && modelReady) {
        const { x: screenX, y: screenY } = mouseRef.current;
        const { x: dasherX, y: dasherY } = view.screen2Dasher(screenX, screenY);

        model.scheduleOneStep(dasherX, dasherY, settings.zoomSpeed);

        while (view.isSpaceAroundNode(model.rootmin, model.rootmax)) {
          if (!model.reparentRoot()) break;
        }

        if (model.root.onlyChildRendered) {
          const child = model.root.onlyChildRendered;
          const bounds = model.getNodeDasherBounds(
            child,
            model.rootmin,
            model.rootmax,
          );
          if (model.coversCrosshair(bounds.y1, bounds.y2)) {
            model.makeRoot(child);
          }
        }

        model.updateOutput();
      }

      render(ctx, model, view, dimensions, settings, mouseRef.current, isPaused);
      animationRef.current = requestAnimationFrame(animate);
    },
    [dimensions, isRunning, isPaused, modelReady, settings],
  );

  useEffect(() => {
    animationRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [animate]);

  // Auto-start when model becomes ready
  useEffect(() => {
    if (modelReady && !isPaused && mouseRef.current.active) {
      setIsRunning(true);
    }
  }, [modelReady, isPaused]);

  // Notify parent of pause state
  useEffect(() => {
    if (onPauseChange) onPauseChange(isPaused);
  }, [isPaused, onPauseChange]);

  // Click to activate
  const handleCanvasClick = useCallback(() => {
    if (isPaused && modelReady) {
      setIsPaused(false);
      setIsRunning(true);
    }
  }, [isPaused, modelReady]);

  // Mouse handlers
  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        active: true,
      };
      if (modelReady && !isPaused && !isRunning) setIsRunning(true);
    }
  }, [modelReady, isPaused, isRunning]);

  const handleMouseEnter = useCallback(() => {
    mouseRef.current.active = true;
    if (modelReady && !isPaused) setIsRunning(true);
  }, [modelReady, isPaused]);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current.active = false;
    setIsRunning(false);
  }, []);

  // Touch handlers (imperative with { passive: false })
  const touchStateRef = useRef({ modelReady, isPaused });
  touchStateRef.current = { modelReady, isPaused };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onTouchStart = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        mouseRef.current = {
          x: touch.clientX - rect.left,
          y: touch.clientY - rect.top,
          active: true,
        };
        const { modelReady, isPaused } = touchStateRef.current;
        if (modelReady && isPaused) {
          setIsPaused(false);
        }
        if (modelReady) setIsRunning(true);
      }
    };
    const onTouchMove = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        mouseRef.current = {
          x: touch.clientX - rect.left,
          y: touch.clientY - rect.top,
          active: true,
        };
      }
    };
    const onTouchEnd = () => {
      mouseRef.current.active = false;
      setIsRunning(false);
    };

    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    return () => {
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: propWidth || "100%",
        height: propHeight || "100%",
        position: "relative",
        overflow: "hidden",
      }}
      onClick={handleCanvasClick}
    >
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          display: "block",
          touchAction: "none",
          cursor: isRunning && !isPaused ? "none" : "default",
        }}
      />
    </div>
  );
}

export default DasherCanvas;
