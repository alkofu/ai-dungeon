import { describe, it, expect } from "vitest";
import { parseSessionMetaPayload } from "./sessionPayload";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = {
  SESSION_TS: "20260425-120000",
  SESSION_SLUG: "smoke-test",
  WORKING_DIRECTORY: "/tmp/smoke",
  BRANCH: "main",
  REPO: "acme/widgets",
  PR_NUM: 42,
  ISSUE_NUM: 17,
};

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_PAYLOAD, ...overrides });
}

// ── Happy-path tests ──────────────────────────────────────────────────────────

describe("parseSessionMetaPayload", () => {
  it("happy path: all fields present returns a valid SessionMeta", () => {
    const result = parseSessionMetaPayload(raw());
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      sessionTs: "20260425-120000",
      slug: "smoke-test",
      workingDirectory: "/tmp/smoke",
      branch: "main",
      prNumber: 42,
      issueNumber: 17,
      repo: { owner: "acme", name: "widgets" },
    });
  });

  it("happy path: only BRANCH present (no WORKTREE) uses BRANCH", () => {
    const result = parseSessionMetaPayload(
      JSON.stringify({
        SESSION_TS: "20260425-120000",
        SESSION_SLUG: "branch-only",
        WORKING_DIRECTORY: "/tmp/x",
        BRANCH: "feat/x",
        REPO: "org/repo",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("feat/x");
  });

  it("happy path: only WORKTREE present (no BRANCH) uses WORKTREE", () => {
    const result = parseSessionMetaPayload(
      JSON.stringify({
        SESSION_TS: "20260425-120000",
        SESSION_SLUG: "worktree-only",
        WORKING_DIRECTORY: "/tmp/y",
        WORKTREE: "wt/feature",
        REPO: "org/repo",
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("wt/feature");
  });

  it("happy path: BRANCH takes precedence over WORKTREE when both present", () => {
    const result = parseSessionMetaPayload(
      raw({ BRANCH: "main", WORKTREE: "wt/main" }),
    );
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
  });

  it("happy path: PR_NUM: null becomes undefined", () => {
    const result = parseSessionMetaPayload(raw({ PR_NUM: null }));
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBeUndefined();
  });

  it("happy path: ISSUE_NUM missing becomes undefined", () => {
    const result = parseSessionMetaPayload(
      JSON.stringify({
        SESSION_TS: "20260425-120000",
        SESSION_SLUG: "no-issue",
        WORKING_DIRECTORY: "/tmp/z",
        BRANCH: "main",
        REPO: "org/repo",
        PR_NUM: 5,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBeUndefined();
  });

  // ── Rejection / null-return tests ─────────────────────────────────────────

  it("malformed JSON returns null without throwing", () => {
    expect(parseSessionMetaPayload("{not json")).toBeNull();
  });

  it("missing SESSION_TS returns null", () => {
    const { SESSION_TS: _, ...rest } = VALID_PAYLOAD;
    expect(parseSessionMetaPayload(JSON.stringify(rest))).toBeNull();
  });

  it("REPO without '/' returns null", () => {
    expect(parseSessionMetaPayload(raw({ REPO: "noslash" }))).toBeNull();
  });

  it("REPO with empty owner (starts with '/') returns null", () => {
    expect(parseSessionMetaPayload(raw({ REPO: "/widgets" }))).toBeNull();
  });

  it("REPO with empty name (ends with '/') returns null", () => {
    expect(parseSessionMetaPayload(raw({ REPO: "acme/" }))).toBeNull();
  });

  it("missing BRANCH and WORKTREE returns null", () => {
    const { BRANCH: _, ...rest } = VALID_PAYLOAD;
    expect(parseSessionMetaPayload(JSON.stringify(rest))).toBeNull();
  });

  // ── Adversarial test cases (Ruinor / Riskmancer requirements) ─────────────

  it("adversarial: payload 'null' returns null and does not throw", () => {
    expect(parseSessionMetaPayload("null")).toBeNull();
  });

  it("adversarial: payload '\"string\"' returns null and does not throw", () => {
    expect(parseSessionMetaPayload('"string"')).toBeNull();
  });

  it("adversarial: payload '[1,2,3]' returns null and does not throw", () => {
    expect(parseSessionMetaPayload("[1,2,3]")).toBeNull();
  });

  it("adversarial: empty string returns null", () => {
    expect(parseSessionMetaPayload("")).toBeNull();
  });

  it("adversarial: payload > 64 KB returns null without calling JSON.parse", () => {
    const bigPayload = "x".repeat(65 * 1024 + 1);
    expect(parseSessionMetaPayload(bigPayload)).toBeNull();
  });

  it("adversarial: SESSION_TS not matching timestamp format returns null", () => {
    expect(parseSessionMetaPayload(raw({ SESSION_TS: "not-a-timestamp" }))).toBeNull();
  });

  it("adversarial: REPO '../etc/passwd' returns null (path traversal)", () => {
    expect(parseSessionMetaPayload(raw({ REPO: "../etc/passwd" }))).toBeNull();
  });

  it("rejects REPO with '..' owner segment", () => {
    expect(parseSessionMetaPayload(JSON.stringify({ ...VALID_PAYLOAD, REPO: "../passwd" }))).toBeNull();
  });

  it("rejects REPO with '..' name segment", () => {
    expect(parseSessionMetaPayload(JSON.stringify({ ...VALID_PAYLOAD, REPO: "owner/.." }))).toBeNull();
  });

  it("adversarial: SESSION_SLUG containing ESC char returns null", () => {
    expect(parseSessionMetaPayload(raw({ SESSION_SLUG: "valid\x1binjected" }))).toBeNull();
  });

  it("adversarial: PR_NUM: -1 returns null", () => {
    expect(parseSessionMetaPayload(raw({ PR_NUM: -1 }))).toBeNull();
  });

  it("adversarial: PR_NUM: 1.5 returns null", () => {
    expect(parseSessionMetaPayload(raw({ PR_NUM: 1.5 }))).toBeNull();
  });

  it("adversarial: ISSUE_NUM: 0 returns null", () => {
    expect(parseSessionMetaPayload(raw({ ISSUE_NUM: 0 }))).toBeNull();
  });
});
