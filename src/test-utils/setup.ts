import "@testing-library/jest-dom/vitest";

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
