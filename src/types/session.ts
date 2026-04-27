/**
 * Claude context populated by OSC 6800 (full payload). All fields are
 * UNTRUSTED — any process in the terminal can emit these. Fields must only be
 * rendered as text (never dangerouslySetInnerHTML, never passed to a shell
 * command or document.title assignment). `branch` and `repo` are optional.
 */
export interface ClaudeContext {
  sessionTs: string;
  slug: string;
  workingDirectory: string;
  branch?: string;
  repo?: { owner: string; name: string };
  prNumber?: number;
  issueNumber?: number;
}

/**
 * Shell context populated by OSC 7 (working directory) and OSC 7337 (git
 * context). All fields are UNTRUSTED — any process in the terminal can emit
 * these. Fields must only be rendered as text (never dangerouslySetInnerHTML,
 * never passed to a shell command or document.title assignment). `branch` and
 * `repo` are optional; they are cleared when an empty OSC 7337 payload is
 * received.
 */
export interface ShellContext {
  workingDirectory: string;
  branch?: string;
  repo?: { owner: string; name: string };
}

/**
 * Aggregate card context: either slot may be present. `claudeContext` wins
 * over `shellContext` for display purposes (ClaudeContext is authoritative
 * over transient shell drift). A mock is shown when neither slot is populated.
 */
export interface CardContext {
  claudeContext?: ClaudeContext;
  shellContext?: ShellContext;
}
