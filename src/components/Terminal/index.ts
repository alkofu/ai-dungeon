import { lazy } from "react";

// Lazy-loaded so the ~349 KB @xterm/xterm payload (xterm core + addon-fit +
// addon-web-fonts statically imported from ./Terminal at lines 34–36) is
// emitted as an async chunk rather than dragged into the synchronous initial
// bundle. This drops the sync chunk under the 500 kB Vite warning threshold
// and improves WebView startup parse time. Mount-ordering invariants
// (font preload before term.open(), onData registered synchronously, fit
// synchronous) live inside ./Terminal's useEffect, not at module scope, so
// React.lazy is safe — the useEffect contract is untouched.
//
// Tests that need the eager (non-lazy) export — Terminal.test.tsx, App.test.tsx,
// AppLayout.test.tsx — either import { Terminal } from "./Terminal" directly
// (the source module, bypassing this lazy wrapper) or vi.mock("../Terminal", ...)
// to swap the lazy export for an eager pass-through (see Step 4).
export const Terminal = lazy(() => import("./Terminal").then((m) => ({ default: m.Terminal })));
