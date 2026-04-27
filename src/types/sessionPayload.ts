import type { SessionContext } from "./session";

/**
 * Wire-format JSON shape of an OSC 6800 payload emitted by the TPK toolkit.
 * These fields are UNTRUSTED — they are validated by parseSessionContextPayload
 * before being consumed by the application.
 */
export type SessionContextPayload = {
  SESSION_TS: string;
  SESSION_SLUG: string;
  WORKING_DIRECTORY: string;
  BRANCH?: string;
  WORKTREE?: string;
  REPO: string;
  PR_NUM?: number | null;
  ISSUE_NUM?: number | null;
};

// ── Validation helpers ────────────────────────────────────────────────────────

const MAX_LENGTH = 64 * 1024; // 64 K UTF-16 code units — generous upper bound for realistic session metadata (actual UTF-8 bytes may be 1–4× higher)

const SESSION_TS_RE = /^\d{8}-\d{6}$/;
// GitHub owner/repo: each segment alphanumeric, hyphen, dot, or underscore,
// but must not be "." or ".." (path-traversal defence-in-depth).
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// Per-segment regex for validating individual owner or name segments in
// the OSC 7337 owner/name case (where we split manually before validating).
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Returns true if the string contains any C0 control character (0x00–0x1F) or DEL (0x7F). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) return true;
  }
  return false;
}

function isValidPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parses an OSC 6800 JSON payload into a `SessionContext` (the wire envelope uses
 * `SessionContextPayload` / `SESSION_TS` field names — these are preserved for
 * wire-format compatibility).
 *
 * Returns a `SessionContext` on success, or null if the payload is invalid.
 * Never throws — all parse/validation errors are swallowed and logged in DEV.
 *
 * Validates OSC 6800 payloads. OSC 7 payloads are validated by `parseOsc7Payload`;
 * OSC 7337 payloads by `parseOsc7337Payload`. All three live in this module so that
 * there is a single audit entry point for all inbound OSC data.
 */
export function parseSessionContextPayload(raw: string): SessionContext | null {
  // Guard 1: payload size — checked before JSON.parse to prevent DoS.
  if (raw.length > MAX_LENGTH) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "payload too large", length: raw.length });
    }
    return null;
  }

  // Guard 2: JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "JSON parse error", length: raw.length });
    }
    return null;
  }

  // Guard 3: type-safety — must be a plain object (not null, not array, not primitive)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "not a plain object", length: raw.length });
    }
    return null;
  }

  const p = parsed as Record<string, unknown>;

  // ── Per-field validation ──────────────────────────────────────────────────

  // SESSION_TS: required, must match /^\d{8}-\d{6}$/
  if (typeof p["SESSION_TS"] !== "string" || !SESSION_TS_RE.test(p["SESSION_TS"])) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "invalid SESSION_TS", length: raw.length });
    }
    return null;
  }

  // SESSION_SLUG: required non-empty string, max 256 chars, no control chars
  if (
    typeof p["SESSION_SLUG"] !== "string" ||
    p["SESSION_SLUG"].length === 0 ||
    p["SESSION_SLUG"].length > 256 ||
    hasControlChars(p["SESSION_SLUG"])
  ) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "invalid SESSION_SLUG", length: raw.length });
    }
    return null;
  }

  // WORKING_DIRECTORY: required non-empty string, max 1024 chars, no control chars
  // 1024 chars covers the longest realistic filesystem path on all major OSes
  // (Linux POSIX PATH_MAX = 4096 per component, but full path strings beyond 1024
  // are nearly always synthetic / adversarial in the PTY context).
  if (
    typeof p["WORKING_DIRECTORY"] !== "string" ||
    p["WORKING_DIRECTORY"].length === 0 ||
    p["WORKING_DIRECTORY"].length > 1024 ||
    hasControlChars(p["WORKING_DIRECTORY"])
  ) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", {
        reason: "invalid WORKING_DIRECTORY",
        length: raw.length,
      });
    }
    return null;
  }

  // REPO: required, must match owner/repo format — rejects path traversal
  if (typeof p["REPO"] !== "string" || !REPO_RE.test(p["REPO"])) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "invalid REPO", length: raw.length });
    }
    return null;
  }

  // Split REPO into owner/name — REPO_RE already guarantees both sides non-empty
  const slashIdx = p["REPO"].indexOf("/");
  const repoOwner = p["REPO"].slice(0, slashIdx);
  const repoName = p["REPO"].slice(slashIdx + 1);

  // Reject bare-dot segments ("." or "..") as an extra path-traversal defence.
  if (repoOwner === "." || repoOwner === ".." || repoName === "." || repoName === "..") {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", { reason: "invalid REPO", length: raw.length });
    }
    return null;
  }

  // BRANCH / WORKTREE: at least one must be a non-empty string with no control chars.
  // BRANCH takes precedence over WORKTREE when both are present.
  const branchRaw = p["BRANCH"];
  const worktreeRaw = p["WORKTREE"];
  const isValidBranch =
    typeof branchRaw === "string" &&
    branchRaw.length > 0 &&
    branchRaw.length <= 256 &&
    !hasControlChars(branchRaw);
  const isValidWorktree =
    typeof worktreeRaw === "string" &&
    worktreeRaw.length > 0 &&
    worktreeRaw.length <= 256 &&
    !hasControlChars(worktreeRaw);

  if (!isValidBranch && !isValidWorktree) {
    if (import.meta.env.DEV) {
      console.warn("[osc-6800] rejected", {
        reason: "missing valid BRANCH or WORKTREE",
        length: raw.length,
      });
    }
    return null;
  }

  const branch = isValidBranch ? (branchRaw as string) : (worktreeRaw as string);

  // PR_NUM: optional — if present must be a positive integer (>= 1)
  let prNumber: number | undefined;
  const prRaw = p["PR_NUM"];
  if (prRaw !== undefined && prRaw !== null) {
    if (!isValidPositiveInt(prRaw)) {
      if (import.meta.env.DEV) {
        console.warn("[osc-6800] rejected", { reason: "invalid PR_NUM", length: raw.length });
      }
      return null;
    }
    prNumber = prRaw;
  }

  // ISSUE_NUM: optional — if present must be a positive integer (>= 1)
  let issueNumber: number | undefined;
  const issueRaw = p["ISSUE_NUM"];
  if (issueRaw !== undefined && issueRaw !== null) {
    if (!isValidPositiveInt(issueRaw)) {
      if (import.meta.env.DEV) {
        console.warn("[osc-6800] rejected", { reason: "invalid ISSUE_NUM", length: raw.length });
      }
      return null;
    }
    issueNumber = issueRaw;
  }

  return {
    sessionTs: p["SESSION_TS"] as string,
    slug: p["SESSION_SLUG"] as string,
    workingDirectory: p["WORKING_DIRECTORY"] as string,
    branch,
    prNumber,
    issueNumber,
    repo: { owner: repoOwner, name: repoName },
  };
}

/**
 * Parses and validates an OSC 7 payload (file:// URI carrying the shell's CWD).
 * Returns a patch-shape object on success, or null on any guard failure.
 * Never throws. All guard failures are silent in production; DEV-only logs are optional.
 *
 * Guards:
 *  1. URL must parse via the WHATWG URL parser (new URL(data)).
 *  2. URL.protocol must be exactly "file:" — rejects javascript:, data:, ftp:, https:, etc.
 *  3. URL.pathname is percent-decoded; on decode failure, the raw pathname is used.
 *  4. The resulting workingDirectory must be ≤ 1024 chars (see rationale comment).
 *  5. The resulting workingDirectory must contain no ASCII control chars (0x00–0x1F, 0x7F).
 */
export function parseOsc7Payload(data: string): { workingDirectory: string } | null {
  let url: URL;
  try {
    url = new URL(data);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  let workingDirectory: string;
  try {
    workingDirectory = decodeURIComponent(url.pathname);
  } catch {
    workingDirectory = url.pathname;
  }
  // 1024 chars covers the longest realistic filesystem path on all major OSes
  // (Linux POSIX PATH_MAX = 4096 per component, but full path strings beyond 1024
  // are nearly always synthetic / adversarial in the PTY context).
  if (workingDirectory.length > 1024) return null;
  if (hasControlChars(workingDirectory)) return null;
  return { workingDirectory };
}

/**
 * Parses and validates an OSC 7337 payload (`repoField\tbranch`, where repoField is
 * normally the bare repo directory name emitted by `basename "$repo_top"` in the
 * Rust backend, or alternatively an `owner/name` form for future / manual-test use).
 *
 * Returns one of:
 *   - `{ branch }` (no `repo` key) for the bare-name production case;
 *   - `{ branch, repo: { owner, name } }` for the alternative `owner/name` case;
 *   - `{ branch: undefined, repo: undefined }` for the empty-payload "git context lost" case;
 *   - `null` on any guard failure.
 *
 * Guards (in order):
 *  1. data === "" → returns the cleared shape (no further validation).
 *  2. data is split on the first \t into [repoField, branch]; both must be non-empty.
 *  3. branch ≤ 256 chars, no ASCII control chars (matches OSC 6800 BRANCH guard).
 *  4. If repoField contains "/", it is split on the FIRST "/" into [owner, name].
 *     Each side must be non-empty, ≤ 256 chars, no control chars, and match SEGMENT_RE
 *     (per-segment regex /^[A-Za-z0-9._-]+$/).
 *  5. If repoField does NOT contain "/", it is the bare-name case — only the branch
 *     guard applies; the bare name itself is NOT dispatched (the OSC 6800 record's
 *     repo field stays authoritative).
 */
export function parseOsc7337Payload(
  data: string,
):
  | { branch: string }
  | { branch: string; repo: { owner: string; name: string } }
  | { branch: undefined; repo: undefined }
  | null {
  if (data === "") return { branch: undefined, repo: undefined };
  const tabIdx = data.indexOf("\t");
  if (tabIdx === -1) return null;
  const repoField = data.slice(0, tabIdx);
  const branch = data.slice(tabIdx + 1);
  if (repoField.length === 0 || branch.length === 0) return null;
  if (branch.length > 256 || hasControlChars(branch)) return null;
  const slashIdx = repoField.indexOf("/");
  if (slashIdx === -1) {
    // Bare repo name (production-normal): patch branch only.
    return { branch };
  }
  const owner = repoField.slice(0, slashIdx);
  const name = repoField.slice(slashIdx + 1);
  if (owner.length === 0 || name.length === 0) return null;
  if (owner.length > 256 || name.length > 256) return null;
  if (hasControlChars(owner) || hasControlChars(name)) return null;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) return null;
  // Bare-dot defence-in-depth (mirrors parseSessionContextPayload).
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { branch, repo: { owner, name } };
}
