/**
 * Tests for NavbarResizer component.
 *
 * Tests cover ARIA/keyboard contract, pointer drag clamping, and commit
 * semantics (fires exactly once per drag, once per keypress).
 */

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NavbarResizer } from "./NavbarResizer";

const DEFAULT_WIDTH = 250;
const MIN = 160;
const MAX = 600;

function renderResizer(overrides: Partial<React.ComponentProps<typeof NavbarResizer>> = {}) {
  const onWidthChange = vi.fn();
  const onCommit = vi.fn();
  const result = render(
    <NavbarResizer
      width={DEFAULT_WIDTH}
      onWidthChange={onWidthChange}
      onCommit={onCommit}
      min={MIN}
      max={MAX}
      visible={true}
      {...overrides}
    />,
  );
  return { ...result, onWidthChange, onCommit };
}

describe("NavbarResizer — ARIA attributes", () => {
  it("renders with role=separator and correct ARIA attributes when visible", () => {
    renderResizer({ width: 300 });
    const sep = screen.getByRole("separator");
    expect(sep).toBeInTheDocument();
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuenow", "300");
    expect(sep).toHaveAttribute("aria-valuemin", String(MIN));
    expect(sep).toHaveAttribute("aria-valuemax", String(MAX));
    expect(sep).toHaveAttribute("aria-label", "Resize sidebar");
    expect(sep).toHaveAttribute("tabindex", "0");
  });

  it("is not queryable by role when visible=false (display:none)", () => {
    renderResizer({ visible: false });
    // Elements with display:none are hidden from the accessibility tree.
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("has tabIndex=-1 when visible=false", () => {
    const { container } = renderResizer({ visible: false });
    // Use container.querySelector because the element is hidden from ARIA tree.
    const sep = container.querySelector("[aria-label='Resize sidebar']");
    expect(sep).not.toBeNull();
    expect(sep).toHaveAttribute("tabindex", "-1");
  });
});

describe("NavbarResizer — pointer drag", () => {
  let setPointerCaptureMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setPointerCaptureMock = vi.fn();
    // jsdom does not implement setPointerCapture — stub it on the prototype.
    window.HTMLElement.prototype.setPointerCapture = setPointerCaptureMock;
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  });

  it("drag from clientX 250 to 350 calls onWidthChange with 350 (delta +100)", () => {
    const { onWidthChange } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 350, buttons: 1 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 350 });

    expect(onWidthChange).toHaveBeenCalledWith(350);
  });

  it("drag past max clamps to 600", () => {
    const { onWidthChange } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    // delta +500 → 250 + 500 = 750, clamped to 600
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 750, buttons: 1 });

    expect(onWidthChange).toHaveBeenCalledWith(600);
  });

  it("drag past min clamps to 160", () => {
    const { onWidthChange } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    // delta -200 → 250 - 200 = 50, clamped to 160
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 50, buttons: 1 });

    expect(onWidthChange).toHaveBeenCalledWith(160);
  });

  it("fires onCommit exactly once on pointerUp after multiple pointermove events", () => {
    const { onCommit } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 260, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 270, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 280, buttons: 1 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 280 });

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("fires onCommit with the current clamped width on pointerUp", () => {
    const { onCommit } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 350, buttons: 1 });
    fireEvent.pointerUp(sep, { pointerId: 1, clientX: 350 });

    expect(onCommit).toHaveBeenCalledWith(350);
  });

  it("pointerCancel fires onCommit exactly once (same as pointerUp)", () => {
    const { onCommit } = renderResizer({ width: 250 });
    const sep = screen.getByRole("separator");

    fireEvent.pointerDown(sep, { pointerId: 1, clientX: 250, buttons: 1 });
    fireEvent.pointerMove(sep, { pointerId: 1, clientX: 300, buttons: 1 });
    fireEvent.pointerCancel(sep, { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe("NavbarResizer — keyboard", () => {
  it("ArrowLeft fires onWidthChange(width - 10) and onCommit(width - 10) and calls preventDefault", () => {
    const { onWidthChange, onCommit } = renderResizer({ width: 300 });
    const sep = screen.getByRole("separator");

    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    act(() => {
      sep.dispatchEvent(event);
    });

    expect(onWidthChange).toHaveBeenCalledWith(290);
    expect(onCommit).toHaveBeenCalledWith(290);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("ArrowRight fires onWidthChange(width + 10) and onCommit(width + 10)", () => {
    const { onWidthChange, onCommit } = renderResizer({ width: 300 });
    const sep = screen.getByRole("separator");

    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    act(() => {
      sep.dispatchEvent(event);
    });

    expect(onWidthChange).toHaveBeenCalledWith(310);
    expect(onCommit).toHaveBeenCalledWith(310);
  });

  it("ArrowRight from near max clamps result to max", () => {
    // width = 595, ArrowRight should produce 600, not 605
    const { onWidthChange, onCommit } = renderResizer({ width: 595 });
    const sep = screen.getByRole("separator");

    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    act(() => {
      sep.dispatchEvent(event);
    });

    expect(onWidthChange).toHaveBeenCalledWith(600);
    expect(onCommit).toHaveBeenCalledWith(600);
  });

  it("ArrowLeft from near min clamps result to min", () => {
    // width = 165, ArrowLeft should produce 160, not 155
    const { onWidthChange, onCommit } = renderResizer({ width: 165 });
    const sep = screen.getByRole("separator");

    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true });
    act(() => {
      sep.dispatchEvent(event);
    });

    expect(onWidthChange).toHaveBeenCalledWith(160);
    expect(onCommit).toHaveBeenCalledWith(160);
  });

  it("other keys are not handled (no call to onWidthChange or onCommit)", () => {
    const { onWidthChange, onCommit } = renderResizer({ width: 300 });
    const sep = screen.getByRole("separator");

    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    act(() => {
      sep.dispatchEvent(event);
    });

    expect(onWidthChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
