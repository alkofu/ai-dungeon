/**
 * Session context populated by OSC 6800 (full payload), and patched by OSC 7
 * (working directory) and OSC 7337 (git context). All fields are UNTRUSTED —
 * any process in the terminal can emit these. Fields must only be rendered as
 * text (never dangerouslySetInnerHTML, never passed to a shell command or
 * document.title assignment). `branch` and `repo` are optional; they are
 * cleared when an empty OSC 7337 payload is received.
 */
export interface SessionContext {
  sessionTs: string;
  slug: string;
  workingDirectory: string;
  branch?: string; // optional — cleared by empty OSC 7337
  repo?: { owner: string; name: string }; // optional — cleared by empty OSC 7337
  prNumber?: number;
  issueNumber?: number;
}
