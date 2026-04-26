import { describe, it, expect } from "vitest";
import {
  parseSessionContextPayload,
  parseOsc7Payload,
  parseOsc7337Payload,
} from "./sessionPayload";

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

describe("parseSessionContextPayload", () => {
  it("happy path: all fields present returns a valid SessionContext", () => {
    const result = parseSessionContextPayload(raw());
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
    const result = parseSessionContextPayload(
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
    const result = parseSessionContextPayload(
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
    const result = parseSessionContextPayload(raw({ BRANCH: "main", WORKTREE: "wt/main" }));
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
  });

  it("happy path: PR_NUM: null becomes undefined", () => {
    const result = parseSessionContextPayload(raw({ PR_NUM: null }));
    expect(result).not.toBeNull();
    expect(result!.prNumber).toBeUndefined();
  });

  it("happy path: ISSUE_NUM missing becomes undefined", () => {
    const result = parseSessionContextPayload(
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
    expect(parseSessionContextPayload("{not json")).toBeNull();
  });

  it("missing SESSION_TS returns null", () => {
    const { SESSION_TS: _, ...rest } = VALID_PAYLOAD;
    expect(parseSessionContextPayload(JSON.stringify(rest))).toBeNull();
  });

  it("REPO without '/' returns null", () => {
    expect(parseSessionContextPayload(raw({ REPO: "noslash" }))).toBeNull();
  });

  it("REPO with empty owner (starts with '/') returns null", () => {
    expect(parseSessionContextPayload(raw({ REPO: "/widgets" }))).toBeNull();
  });

  it("REPO with empty name (ends with '/') returns null", () => {
    expect(parseSessionContextPayload(raw({ REPO: "acme/" }))).toBeNull();
  });

  it("missing BRANCH and WORKTREE returns null", () => {
    const { BRANCH: _, ...rest } = VALID_PAYLOAD;
    expect(parseSessionContextPayload(JSON.stringify(rest))).toBeNull();
  });

  // ── Adversarial test cases (Ruinor / Riskmancer requirements) ─────────────

  it("adversarial: payload 'null' returns null and does not throw", () => {
    expect(parseSessionContextPayload("null")).toBeNull();
  });

  it("adversarial: payload '\"string\"' returns null and does not throw", () => {
    expect(parseSessionContextPayload('"string"')).toBeNull();
  });

  it("adversarial: payload '[1,2,3]' returns null and does not throw", () => {
    expect(parseSessionContextPayload("[1,2,3]")).toBeNull();
  });

  it("adversarial: empty string returns null", () => {
    expect(parseSessionContextPayload("")).toBeNull();
  });

  it("adversarial: payload > 64 KB returns null without calling JSON.parse", () => {
    const bigPayload = "x".repeat(65 * 1024 + 1);
    expect(parseSessionContextPayload(bigPayload)).toBeNull();
  });

  it("adversarial: SESSION_TS not matching timestamp format returns null", () => {
    expect(parseSessionContextPayload(raw({ SESSION_TS: "not-a-timestamp" }))).toBeNull();
  });

  it("adversarial: REPO '../etc/passwd' returns null (path traversal)", () => {
    expect(parseSessionContextPayload(raw({ REPO: "../etc/passwd" }))).toBeNull();
  });

  it("rejects REPO with '..' owner segment", () => {
    expect(
      parseSessionContextPayload(JSON.stringify({ ...VALID_PAYLOAD, REPO: "../passwd" })),
    ).toBeNull();
  });

  it("rejects REPO with '..' name segment", () => {
    expect(
      parseSessionContextPayload(JSON.stringify({ ...VALID_PAYLOAD, REPO: "owner/.." })),
    ).toBeNull();
  });

  it("adversarial: SESSION_SLUG containing ESC char returns null", () => {
    expect(parseSessionContextPayload(raw({ SESSION_SLUG: "valid\x1binjected" }))).toBeNull();
  });

  it("adversarial: PR_NUM: -1 returns null", () => {
    expect(parseSessionContextPayload(raw({ PR_NUM: -1 }))).toBeNull();
  });

  it("adversarial: PR_NUM: 1.5 returns null", () => {
    expect(parseSessionContextPayload(raw({ PR_NUM: 1.5 }))).toBeNull();
  });

  it("adversarial: ISSUE_NUM: 0 returns null", () => {
    expect(parseSessionContextPayload(raw({ ISSUE_NUM: 0 }))).toBeNull();
  });
});

// ── parseOsc7Payload ──────────────────────────────────────────────────────────

describe("parseOsc7Payload", () => {
  it("happy path: file://localhost URI returns workingDirectory", () => {
    const result = parseOsc7Payload("file://localhost/Users/me/projects/foo");
    expect(result).toEqual({ workingDirectory: "/Users/me/projects/foo" });
  });

  it("empty-host file URI (file:///path) returns workingDirectory", () => {
    const result = parseOsc7Payload("file:///Users/me/projects/foo");
    expect(result).toEqual({ workingDirectory: "/Users/me/projects/foo" });
  });

  it("percent-encoded path is decoded correctly", () => {
    const result = parseOsc7Payload("file:///Users/me/My%20Projects/foo");
    expect(result).toEqual({ workingDirectory: "/Users/me/My Projects/foo" });
  });

  it("root-only path returns workingDirectory of '/'", () => {
    const result = parseOsc7Payload("file:///");
    expect(result).toEqual({ workingDirectory: "/" });
  });

  it("malformed percent-encoding falls back to raw pathname", () => {
    const result = parseOsc7Payload("file:///bad%path");
    expect(result).toEqual({ workingDirectory: "/bad%path" });
  });

  it("non-file: scheme (https) is rejected", () => {
    expect(parseOsc7Payload("https://example.com/path")).toBeNull();
  });

  it("non-file: scheme (javascript:) is rejected", () => {
    expect(parseOsc7Payload("javascript:alert(1)")).toBeNull();
  });

  it("non-file: scheme (data:) is rejected", () => {
    expect(parseOsc7Payload("data:text/plain;base64,Zm9v")).toBeNull();
  });

  it("malformed URL returns null", () => {
    expect(parseOsc7Payload("not a url")).toBeNull();
  });

  it("path > 1024 chars returns null", () => {
    expect(parseOsc7Payload("file:///" + "a".repeat(2000))).toBeNull();
  });

  it("control char in path returns null", () => {
    expect(parseOsc7Payload("file:///foo\x01bar")).toBeNull();
  });
});

// ── parseOsc7337Payload ───────────────────────────────────────────────────────

describe("parseOsc7337Payload", () => {
  it("bare repo name (production wire format) returns branch only, no repo key", () => {
    const result = parseOsc7337Payload("ai-dungeon\tmain");
    expect(result).toEqual({ branch: "main" });
    expect(result).not.toHaveProperty("repo");
  });

  it("owner/name form returns full repo + branch", () => {
    const result = parseOsc7337Payload("acme/widgets\tmain");
    expect(result).toEqual({ branch: "main", repo: { owner: "acme", name: "widgets" } });
  });

  it("empty payload returns cleared shape", () => {
    const result = parseOsc7337Payload("");
    expect(result).toEqual({ branch: undefined, repo: undefined });
  });

  it("no tab returns null", () => {
    expect(parseOsc7337Payload("no-tab")).toBeNull();
  });

  it("empty branch field returns null", () => {
    expect(parseOsc7337Payload("acme/widgets\t")).toBeNull();
  });

  it("empty repo field returns null", () => {
    expect(parseOsc7337Payload("\tmain")).toBeNull();
  });

  it("owner/name where owner is empty (/widgets) returns null", () => {
    expect(parseOsc7337Payload("/widgets\tmain")).toBeNull();
  });

  it("owner/name where name is empty (acme/) returns null", () => {
    expect(parseOsc7337Payload("acme/\tmain")).toBeNull();
  });

  it("branch with control char returns null", () => {
    expect(parseOsc7337Payload("ai-dungeon\tma\x01in")).toBeNull();
  });

  it("branch > 256 chars (bare-name path) returns null", () => {
    expect(parseOsc7337Payload("ai-dungeon\t" + "b".repeat(257))).toBeNull();
  });

  it("branch > 256 chars (owner/name path) returns null", () => {
    expect(parseOsc7337Payload("acme/widgets\t" + "b".repeat(257))).toBeNull();
  });

  it("repo segment with control char in owner returns null", () => {
    expect(parseOsc7337Payload("ac\x01me/widgets\tmain")).toBeNull();
  });

  it("repo segment with control char in name returns null", () => {
    expect(parseOsc7337Payload("acme/wi\x01dgets\tmain")).toBeNull();
  });

  it("repo segment with invalid character ($) in owner returns null", () => {
    expect(parseOsc7337Payload("acme$/widgets\tmain")).toBeNull();
  });

  it("bare-dot owner segment (.) returns null", () => {
    expect(parseOsc7337Payload("./widgets\tmain")).toBeNull();
  });

  it("bare-dot owner segment (..) returns null", () => {
    expect(parseOsc7337Payload("../widgets\tmain")).toBeNull();
  });

  it("bare-dot name segment (.) returns null", () => {
    expect(parseOsc7337Payload("acme/.\tmain")).toBeNull();
  });

  it("bare-dot name segment (..) returns null", () => {
    expect(parseOsc7337Payload("acme/..\tmain")).toBeNull();
  });
});
