import type { SessionMeta } from "./session";

/**
 * Wire-format JSON shape of an OSC 6800 payload emitted by the TPK toolkit.
 * These fields are UNTRUSTED — they are validated by parseSessionMetaPayload
 * before being consumed by the application.
 */
export type SessionMetaPayload = {
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
 * Parses and validates an OSC 6800 payload string.
 * Returns a SessionMeta on success, or null if the payload is invalid.
 * Never throws — all parse/validation errors are swallowed and logged in DEV.
 */
export function parseSessionMetaPayload(raw: string): SessionMeta | null {
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
