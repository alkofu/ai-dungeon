import "@testing-library/jest-dom/vitest";

// jsdom does not implement Element.prototype.scrollIntoView. Mantine's Combobox
// component calls scrollIntoView on list items (e.g. when navigating a Select
// dropdown). Without this stub, an unhandled exception fires after tests that
// interact with Mantine Select components.
Element.prototype.scrollIntoView = vi.fn();

// jsdom does not implement window.matchMedia. Mantine's MantineProvider uses
// it to detect the user's preferred color scheme. This stub satisfies the API
// so that tests can render Mantine components without throwing.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// --- xterm.js jsdom stubs ---
// xterm requires HTMLCanvasElement.getContext and ResizeObserver, which jsdom does not implement.
// These stubs prevent 'not implemented' errors during unit tests.

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: vi.fn(() => ({
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    putImageData: vi.fn(),
    createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    translate: vi.fn(),
    transform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    rect: vi.fn(),
    clip: vi.fn(),
    arc: vi.fn(),
    font: "",
    fillStyle: "",
    strokeStyle: "",
    textBaseline: "",
  })),
  writable: true,
  configurable: true,
});

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
}) as unknown as typeof ResizeObserver;
