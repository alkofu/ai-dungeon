/**
 * Session metadata sourced from OSC 6800 sequences emitted by the PTY.
 * All fields are UNTRUSTED — any process in the terminal can emit these.
 * Fields must only be rendered as text (never dangerouslySetInnerHTML, never
 * passed to a shell command or document.title assignment).
 */
export interface SessionMeta {
  sessionTs: string;
  slug: string;
  workingDirectory: string;
  branch: string;
  prNumber?: number;
  issueNumber?: number;
  repo: {
    owner: string;
    name: string;
  };
}
