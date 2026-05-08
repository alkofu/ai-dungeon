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

import React, { useEffect, useRef } from "react";

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
  // Sync from the `width` prop only when not dragging — syncing unconditionally
  // would overwrite the drag-accumulated value when the parent re-renders mid-drag
  // (e.g., an external settings update arrives while the user is still dragging).
  const currentWidthRef = useRef(width);

  useEffect(() => {
    if (!draggingRef.current) {
      currentWidthRef.current = width;
    }
  }, [width]);

  // Cleanup guard: if NavbarResizer unmounts while a drag is in flight
  // (e.g., hot-reload, route change, error boundary), the "is-resizing"
  // class must be removed so Terminal's ResizeObserver resumes normally.
  useEffect(() => {
    return () => {
      document.body.classList.remove("is-resizing"); // sentinel read by Terminal.tsx's ResizeObserver gate
    };
  }, []);

  // Ref to the separator element for direct aria-valuenow mutation during drag.
  // Because the parent no longer updates liveWidth on every pointermove (to avoid
  // React re-renders that cause the terminal blink), aria-valuenow would otherwise
  // stay stale at the pre-drag value throughout the drag. We mutate it directly
  // so screen readers and tests see the live position without scheduling a re-render.
  const separatorRef = useRef<HTMLDivElement | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    startClientXRef.current = e.clientX;
    startWidthRef.current = currentWidthRef.current;
    document.body.classList.add("is-resizing"); // sentinel read by Terminal.tsx's ResizeObserver gate
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const next = clamp(startWidthRef.current + (e.clientX - startClientXRef.current), min, max);
    currentWidthRef.current = next;
    // Update aria-valuenow directly so it reflects the live drag position.
    // The React prop (width) stays at the pre-drag value until onCommit fires.
    separatorRef.current?.setAttribute("aria-valuenow", String(next));
    onWidthChange(next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(currentWidthRef.current);
    // Defer class removal to the next animation frame so the add (pointerDown)
    // and remove are always in separate tasks. If they land in the same task,
    // the MutationObserver batches them to a net-zero change and the
    // falling-edge wasResizing guard in Terminal.tsx never fires.
    // The useEffect cleanup below removes the class synchronously on unmount,
    // so an in-flight RAF that fires after unmount is a harmless no-op.
    requestAnimationFrame(() => {
      // Guard against a new drag starting before this RAF fires.
      // If draggingRef is true, the new drag's pointerDown has already
      // re-set the class; do not clear it.
      if (!draggingRef.current) {
        document.body.classList.remove("is-resizing"); // sentinel read by Terminal.tsx's ResizeObserver gate
      }
    });
    // aria-valuenow will be set correctly by React on the next render after
    // onCommit triggers setLiveWidth(final) in the parent.
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
      ref={separatorRef}
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
