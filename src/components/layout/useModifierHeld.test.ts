import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform, useModifierHeld } from "./useModifierHeld";

// ── Platform stub helpers ─────────────────────────────────────────────────────

function stubMacOS() {
  Object.defineProperty(navigator, "userAgentData", {
    value: { platform: "macOS" },
    configurable: true,
    writable: true,
  });
}

function clearUserAgentData() {
  Object.defineProperty(navigator, "userAgentData", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// ── useModifierHeld tests ─────────────────────────────────────────────────────

describe("useModifierHeld", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubMacOS();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearUserAgentData();
  });

  it("1. initial value is false", () => {
    const { result } = renderHook(() => useModifierHeld());
    expect(result.current).toBe(false);
  });

  it("2. after keydown Meta and advancing 250 ms, value is true", async () => {
    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(true);
  });

  it("3. keydown then keyup within 100 ms then advance to 250 ms — stays false", async () => {
    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(false);
  });

  it("4. after becoming true, keyup Meta flips back to false", async () => {
    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", bubbles: true }));
    });

    expect(result.current).toBe(false);
  });

  it("5. after becoming true, window blur flips back to false", async () => {
    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current).toBe(false);
  });

  it("6. after becoming true, document.hidden=true + visibilitychange flips back to false", async () => {
    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(true);

    await act(async () => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current).toBe(false);

    // Restore document.hidden
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("7. non-macOS branch: only Control triggers; Meta is ignored even after 250 ms", async () => {
    // Override to non-macOS
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "Linux" },
      configurable: true,
      writable: true,
    });

    const { result } = renderHook(() => useModifierHeld());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(false);

    // Control should work
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(true);
  });

  it("8. event.repeat === true does not start a fresh timer", async () => {
    const { result } = renderHook(() => useModifierHeld());

    // Fire with repeat=true — this should be ignored entirely
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Meta", bubbles: true, repeat: true }),
    );

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(result.current).toBe(false);
  });

  it("9. unmount removes listeners", () => {
    const windowAddSpy = vi.spyOn(window, "addEventListener");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const docRemoveSpy = vi.spyOn(document, "removeEventListener");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    const { unmount } = renderHook(() => useModifierHeld());

    // Fire keydown to schedule the hold timer — ensures timerRef.current is
    // non-null so clearTimeout is exercised by the cleanup function on unmount.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", bubbles: true }));

    unmount();

    // window listeners for keydown, keyup, blur must be removed
    expect(windowRemoveSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith("keyup", expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith("blur", expect.any(Function));

    // document listener for visibilitychange must be removed
    expect(docRemoveSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    // clearTimeout must be called on unmount to cancel the pending timer
    expect(clearTimeoutSpy).toHaveBeenCalled();

    windowAddSpy.mockRestore();
    windowRemoveSpy.mockRestore();
    docRemoveSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

// ── isMacPlatform tests ───────────────────────────────────────────────────────

describe("isMacPlatform", () => {
  afterEach(() => {
    clearUserAgentData();
    Object.defineProperty(navigator, "platform", {
      value: "",
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, "userAgent", {
      value: navigator.userAgent,
      configurable: true,
      writable: true,
    });
  });

  it("10. userAgent-only fallback: with userAgentData=undefined, platform='', userAgent containing Macintosh, returns true", () => {
    Object.defineProperty(navigator, "userAgentData", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, "platform", {
      value: "",
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      configurable: true,
      writable: true,
    });

    expect(isMacPlatform()).toBe(true);
  });
});
