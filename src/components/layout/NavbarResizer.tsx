/**
 * NavbarResizer — draggable vertical separator between the sidebar and main.
 *
 * Positioning strategy (F-3):
 *   AppShell.Navbar has its p="md" padding moved to an inner <Box> wrapper
 *   in AppLayout.tsx, so the navbar element itself is unpadded. This component
 *   is rendered as an absolutely-positioned sibling of that inner box, anchored
 *   to right:0 on the unpadded navbar — which is exactly the sidebar/main
 *   boundary. z-index keeps it above navbar content during hover.
 *
 * Keyboard repeat / persistence (F-1):
 *   onCommit fires on every ArrowLeft/ArrowRight keydown. The debounce that
 *   prevents excessive persistence writes lives inside useNavbarWidth.setWidth,
 *   which is what the parent passes as onCommit. This component is unaware of
 *   debouncing — it delegates that concern to the caller.
 *
 * Tabs focus management (F-4):
 *   The separator has tabIndex=0 when visible, making it Tab-reachable. The
 *   ArrowLeft/ArrowRight handlers call e.preventDefault() as a defensive
 *   measure — it prevents browser default scroll behaviour (some browsers
 *   scroll horizontally on ArrowLeft/ArrowRight). For <Tabs orientation="vertical">
 *   specifically, Mantine uses ArrowUp/ArrowDown for tab switching, not
 *   ArrowLeft/ArrowRight, so there is no roving-tabindex collision to guard
 *   against.
 */

import React, { useRef } from "react";

export interface NavbarResizerProps {
  /** Current sidebar width in pixels (used for ARIA and drag start). */
  width: number;
  /** Fires on every pointermove during drag. The parent uses this to update local live-width state. */
  onWidthChange: (next: number) => void;
  /** Fires once on pointerUp/pointerCancel and once per keyboard nudge. The parent persists this. */
  onCommit: (final: number) => void;
  min: number;
  max: number;
  /** When false, the separator is hidden (display:none) and unfocusable. */
  visible: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function NavbarResizer({
  width,
  onWidthChange,
  onCommit,
  min,
  max,
  visible,
}: NavbarResizerProps) {
  // Drag state tracked in refs to avoid triggering re-renders on every pointermove.
  const draggingRef = useRef(false);
  const startClientXRef = useRef(0);
  const startWidthRef = useRef(0);
  // Track the most recent live width so onCommit fires the right value on pointerUp.
  const currentWidthRef = useRef(width);
  currentWidthRef.current = width;

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    startClientXRef.current = e.clientX;
    startWidthRef.current = currentWidthRef.current;
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const next = clamp(startWidthRef.current + (e.clientX - startClientXRef.current), min, max);
    currentWidthRef.current = next;
    onWidthChange(next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(currentWidthRef.current);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const next = clamp(width - 10, min, max);
      onWidthChange(next);
      onCommit(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = clamp(width + 10, min, max);
      onWidthChange(next);
      onCommit(next);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label="Resize sidebar"
      tabIndex={visible ? 0 : -1}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      style={{
        display: visible ? undefined : "none",
        // Positioned at the right edge of the unpadded AppShell.Navbar.
        // See positioning strategy comment at the top of this file.
        position: "absolute",
        top: 0,
        right: 0,
        width: 6,
        height: "100%",
        cursor: "col-resize",
        zIndex: 10,
        // Subtle visual affordance: slightly darker on hover/focus.
        // Not load-bearing — pure cosmetic.
        backgroundColor: "transparent",
        userSelect: "none",
        touchAction: "none",
      }}
    />
  );
}
