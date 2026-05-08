import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { Tabs } from "@mantine/core";
import { renderWithProviders } from "../../test-utils/render";
import { SessionCard } from "./SessionCard";
import { getMockSessionContext, SESSION_CONTEXT_FIXTURES } from "./sessionContext.mock";
import type { ShellContext } from "../../types/session";

// SHORTCUT_GLYPH in SessionCard.tsx is a module-level constant evaluated at
// import time. Mock isMacPlatform to return true so the constant is "⌘" in
// every test in this file (no test here expects "Ctrl+").
vi.mock("./useModifierHeld", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useModifierHeld")>();
  return { ...original, isMacPlatform: () => true };
});

// Cards 1–5 are wrapped in Tabs context matching production rendering.
function renderInTabs(cardId: string, onRemove = vi.fn()) {
  return renderWithProviders(
    <Tabs value={null} onChange={() => {}} orientation="vertical">
      <Tabs.Tab value={cardId}>
        <SessionCard cardId={cardId} onRemove={onRemove} />
      </Tabs.Tab>
    </Tabs>,
  );
}

/**
 * Returns the closest `.mantine-Badge-root` ancestor of the icon element
 * with the given aria-label. Throws if the icon is not found.
 */
function getBadgeContainingIcon(ariaLabel: string): Element {
  const icon = screen.getByRole("img", { name: ariaLabel });
  const badge = icon.closest(".mantine-Badge-root");
  if (!badge) {
    throw new Error(`No .mantine-Badge-root ancestor found for icon "${ariaLabel}"`);
  }
  return badge;
}

describe("SessionCard", () => {
  // Use fixture 0 (slug: "refactor-auth-flow", repo: acme-corp/ai-dungeon,
  // workingDirectory: "~/projects/ai-dungeon", prNumber: 42, issueNumber: 17)
  // "d" = charCode 100; 100 % 4 = 0 → fixture 0
  const CARD_ID_F0 = "d";

  // Use fixture 1 (slug: "fix-terminal-resize", repo: acme-corp/backend-service,
  // workingDirectory: "/home/user/work/backend-service/src/handlers",
  // prNumber: 7, issueNumber: undefined)
  // Need a cardId whose charCode sum % 4 === 1
  // "b" = 98; 98 % 4 = 2. "e" = 101; 101 % 4 = 1. Use "e".
  const CARD_ID_F1 = "e";

  // Use fixture 2 (slug: "add-issue-tracker", issueNumber: 99, prNumber: undefined)
  // "f" = 102; 102 % 4 = 2. Use "f".
  const CARD_ID_F2 = "f";

  // Use fixture 3 (slug: "chore-update-deps", prNumber: undefined, issueNumber: undefined)
  // "g" = 103; 103 % 4 = 3. Use "g".
  const CARD_ID_F3 = "g";

  it("1. renders the slug from the mock fixture for the given cardId", () => {
    renderInTabs(CARD_ID_F0);
    expect(screen.getByText(SESSION_CONTEXT_FIXTURES[0].slug)).toBeInTheDocument();
  });

  it("2. renders close button with correct aria-label and calls onRemove when clicked", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    const { container } = renderInTabs("abcdefgh-1234-5678-abcd-ef1234567890", onRemove);

    const btn = screen.getByRole("button", { name: "Remove card abcdefgh" });
    expect(btn).toBeInTheDocument();

    // Fire mouseEnter on the card to set hovered=true — pointer-events: none
    // on the close button blocks user.hover(), so we trigger the React synthetic
    // event directly via fireEvent.
    const card = container.querySelector("[data-active]") as Element;
    fireEvent.mouseEnter(card);
    await user.click(btn);

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("abcdefgh-1234-5678-abcd-ef1234567890");
  });

  it("3. calls onRemove when Enter is pressed on the close button", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    renderInTabs("a", onRemove);

    const btn = screen.getByRole("button", { name: "Remove card a" });
    btn.focus();
    await user.keyboard("{Enter}");

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("4. calls onRemove when Space is pressed on the close button", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    renderInTabs("a", onRemove);

    const btn = screen.getByRole("button", { name: "Remove card a" });
    btn.focus();
    await user.keyboard(" ");

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("6. tooltip on repo name shows owner/name", async () => {
    const user = userEvent.setup();
    renderInTabs(CARD_ID_F0);

    const meta = SESSION_CONTEXT_FIXTURES[0];
    const trigger = screen.getByText(meta.repo!.name);
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(`${meta.repo!.owner}/${meta.repo!.name}`);
  });

  it("7. tooltip on branch text shows the full working-directory path", async () => {
    const user = userEvent.setup();
    // Use fixture 1: branch "fix/terminal-resize", full path "/home/user/work/backend-service/src/handlers"
    renderInTabs(CARD_ID_F1);

    const trigger = screen.getByText(SESSION_CONTEXT_FIXTURES[1].branch!);
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(SESSION_CONTEXT_FIXTURES[1].workingDirectory);
  });

  it("8. working-directory text is no longer rendered in the visible DOM", () => {
    // Fixture 1: "/home/user/work/backend-service/src/handlers" — the path tail ("src/handlers")
    // must NOT appear as visible text; the full path must also not appear.
    renderInTabs(CARD_ID_F1);
    expect(screen.queryByText("src/handlers")).toBeNull();
    expect(screen.queryByText(SESSION_CONTEXT_FIXTURES[1].workingDirectory)).toBeNull();
  });

  it("9a. PR badge is omitted entirely when prNumber is undefined", () => {
    // Fixture 2 has no prNumber — badge and icon must both be absent
    renderInTabs(CARD_ID_F2);
    expect(screen.queryByRole("img", { name: "Pull request" })).toBeNull();
  });

  it("9b. PR badge shows '#n' when prNumber is defined", () => {
    // Fixture 0 has prNumber: 42
    renderInTabs(CARD_ID_F0);
    const badge = getBadgeContainingIcon("Pull request");
    expect(badge.textContent).toContain("#42");
  });

  it("9c. PR badge renders the pull-request icon when prNumber is defined", () => {
    // Fixture 0 has prNumber: 42
    renderInTabs(CARD_ID_F0);
    expect(screen.getByRole("img", { name: "Pull request" })).toBeInTheDocument();
  });

  it("10a. Issue badge is omitted entirely when issueNumber is undefined", () => {
    // Fixture 1 has no issueNumber — icon must be absent
    renderInTabs(CARD_ID_F1);
    expect(screen.queryByRole("img", { name: "Issue" })).toBeNull();
  });

  it("10b. Issue badge shows '#n' when issueNumber is defined", () => {
    // Fixture 0 has issueNumber: 17
    renderInTabs(CARD_ID_F0);
    expect(screen.getByText("#17")).toBeInTheDocument();
  });

  it("10c. Issue badge renders the issue icon when issueNumber is defined", () => {
    // Fixture 0 has issueNumber: 17
    renderInTabs(CARD_ID_F0);
    expect(screen.getByRole("img", { name: "Issue" })).toBeInTheDocument();
  });

  it("11c. PR and Issue badges are both absent when fixture has neither prNumber nor issueNumber", () => {
    renderInTabs(CARD_ID_F3);
    expect(screen.queryByRole("img", { name: "Pull request" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Issue" })).toBeNull();
    expect(screen.queryByText(/^PR/)).toBeNull();
  });

  it("11d. only PR badge renders when issueNumber is absent (fixture 1)", () => {
    // Fixture 1: prNumber=7, issueNumber=undefined
    const { container } = renderInTabs(CARD_ID_F1);
    const badge = getBadgeContainingIcon("Pull request");
    expect(badge.textContent).toContain("#7");
    expect(screen.queryByRole("img", { name: "Issue" })).toBeNull();
    const badges = container.querySelectorAll(".mantine-Badge-root");
    expect(badges).toHaveLength(1);
  });

  it("11e. only Issue badge renders when prNumber is absent (fixture 2)", () => {
    // Fixture 2: prNumber=undefined, issueNumber=99
    const { container } = renderInTabs(CARD_ID_F2);
    expect(screen.getByText("#99")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Issue" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pull request" })).toBeNull();
    const badges = container.querySelectorAll(".mantine-Badge-root");
    expect(badges).toHaveLength(1);
  });

  describe("active visual state", () => {
    it("defaults to inactive", () => {
      const { container } = renderInTabs(CARD_ID_F0);
      expect(container.querySelector('[data-active="false"]')).not.toBeNull();
      expect(container.querySelector('[data-active="true"]')).toBeNull();
    });

    it("active=true", () => {
      const { container } = renderWithProviders(
        <Tabs value={null} onChange={() => {}} orientation="vertical">
          <Tabs.Tab value={CARD_ID_F0}>
            <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} active={true} />
          </Tabs.Tab>
        </Tabs>,
      );
      expect(container.querySelector('[data-active="true"]')).not.toBeNull();
    });

    it("active=false explicit", () => {
      const { container } = renderWithProviders(
        <Tabs value={null} onChange={() => {}} orientation="vertical">
          <Tabs.Tab value={CARD_ID_F0}>
            <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} active={false} />
          </Tabs.Tab>
        </Tabs>,
      );
      expect(container.querySelector('[data-active="false"]')).not.toBeNull();
    });
  });

  describe("status subtitle", () => {
    it("status omitted", () => {
      renderInTabs(CARD_ID_F0);
      expect(screen.queryByText(/Claude is waiting/)).toBeNull();
    });

    it("status set", () => {
      renderWithProviders(
        <Tabs value={null} onChange={() => {}} orientation="vertical">
          <Tabs.Tab value={CARD_ID_F0}>
            <SessionCard
              cardId={CARD_ID_F0}
              onRemove={vi.fn()}
              status="Claude is waiting for your input"
            />
          </Tabs.Tab>
        </Tabs>,
      );
      expect(screen.getByText("Claude is waiting for your input")).toBeInTheDocument();
    });
  });

  it("mock module is deterministic: same cardId returns deeply equal objects", () => {
    const id = "test-determinism-check";
    const a = getMockSessionContext(id);
    const b = getMockSessionContext(id);
    expect(a).toEqual(b);
  });

  // ── Two-slot rendering tests (Step 3) ─────────────────────────────────────

  it("renders shell context when no session context: slug is '(shell)', branch and repo from shellContext appear", () => {
    const shellCtx: ShellContext = {
      workingDirectory: "/shell/path/to/project",
      branch: "shell-branch",
      repo: { owner: "shell-owner", name: "shell-repo" },
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="shell-card">
          <SessionCard cardId="shell-card" onRemove={vi.fn()} shellContext={shellCtx} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("(shell)")).toBeInTheDocument();
    expect(screen.getByText("shell-branch")).toBeInTheDocument();
    expect(screen.getByText("shell-repo")).toBeInTheDocument();
  });

  it("session context wins over shell context when both present", () => {
    const shellCtx: ShellContext = {
      workingDirectory: "/shell/path",
      branch: "shell-branch",
    };
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "session-slug",
      workingDirectory: "/session/path",
      branch: "session-branch",
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="combined-card">
          <SessionCard
            cardId="combined-card"
            onRemove={vi.fn()}
            sessionContext={sessionCtx}
            shellContext={shellCtx}
          />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("session-slug")).toBeInTheDocument();
    expect(screen.getByText("session-branch")).toBeInTheDocument();
    expect(screen.queryByText("shell-branch")).toBeNull();
  });

  it("falls back to mock when neither sessionContext nor shellContext present", () => {
    renderInTabs(CARD_ID_F0);
    const fixture = SESSION_CONTEXT_FIXTURES[0];
    expect(screen.getByText(fixture.slug)).toBeInTheDocument();
  });

  // F-2: session context with branch + cleared shell context shows session branch
  it("session context with branch present + empty OSC 7337 cleared shell context: SessionCard shows the session branch, not cleared", () => {
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "session-with-branch",
      workingDirectory: "/session/path",
      branch: "session-main",
      repo: { owner: "session-owner", name: "session-repo" },
    };
    // Cleared shell context: no branch, no repo (simulates OSC 7337 clear)
    const clearedShellCtx: ShellContext = {
      workingDirectory: "/shell/path",
      branch: undefined,
      repo: undefined,
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="f2-card">
          <SessionCard
            cardId="f2-card"
            onRemove={vi.fn()}
            sessionContext={sessionCtx}
            shellContext={clearedShellCtx}
          />
        </Tabs.Tab>
      </Tabs>,
    );
    // Session branch must be visible.
    expect(screen.getByText("session-main")).toBeInTheDocument();
    // Session slug must be visible.
    expect(screen.getByText("session-with-branch")).toBeInTheDocument();
  });

  // ── sessionContext prop tests ──────────────────────────────────────────────

  it("fallback: when sessionContext prop is omitted, renders slug/repo/branch from mock fixture", () => {
    renderInTabs(CARD_ID_F0);
    const fixture = SESSION_CONTEXT_FIXTURES[0];
    expect(screen.getByText(fixture.slug)).toBeInTheDocument();
    expect(screen.getByText(fixture.repo!.name)).toBeInTheDocument();
    expect(screen.getByText(fixture.branch!)).toBeInTheDocument();
  });

  it("live: when sessionContext prop is provided, renders slug/repo/branch from prop (not mock)", () => {
    const liveContext = {
      sessionTs: "20260425-120000",
      slug: "live-session",
      workingDirectory: "/live/path/to/project",
      branch: "feat/live-branch",
      repo: { owner: "live-owner", name: "live-repo" },
      prNumber: 99,
      issueNumber: 7,
    };
    const { unmount: unmountFirst } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} sessionContext={liveContext} />
        </Tabs.Tab>
      </Tabs>,
    );

    // Live context must be shown.
    expect(screen.getByText("live-session")).toBeInTheDocument();
    expect(screen.getByText("live-repo")).toBeInTheDocument();
    expect(screen.getByText("feat/live-branch")).toBeInTheDocument();

    // Mock fixture data must NOT appear.
    const fixture = SESSION_CONTEXT_FIXTURES[0];
    expect(screen.queryByText(fixture.slug)).toBeNull();

    unmountFirst();

    // (a) Repo + branch absent — does not throw, slug still visible.
    const clearedContext = {
      sessionTs: "20260425-120000",
      slug: "live-session",
      workingDirectory: "/live/path/to/project",
      repo: undefined,
      branch: undefined,
    };
    const { unmount: unmountCleared } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} sessionContext={clearedContext} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("live-session")).toBeInTheDocument();
    unmountCleared();

    // (b) Existing-fixture behaviour preserved — repo name visible with non-cleared fixture.
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} sessionContext={liveContext} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText(liveContext.repo!.name)).toBeInTheDocument();
  });

  // ── Modifier-gated shortcut chip tests ───────────────────────────────────

  it("renders the shortcut chip when position is 1–9 and modifierPressed is true", () => {
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="card-3">
          <SessionCard cardId="card-3" onRemove={vi.fn()} position={3} modifierPressed={true} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("⌘3")).toBeInTheDocument();
  });

  it("does not render the shortcut chip when modifierPressed is false even if position is 1–9", () => {
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="card-3">
          <SessionCard cardId="card-3" onRemove={vi.fn()} position={3} modifierPressed={false} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.queryByText(/^⌘/)).toBeNull();
  });

  it("does not render the shortcut chip when position is undefined or > 9", () => {
    // Case 1: no position (modifierPressed=true to isolate the position guard)
    const { unmount } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="card-x">
          <SessionCard cardId="card-x" onRemove={vi.fn()} modifierPressed={true} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.queryByText(/^⌘/)).toBeNull();
    unmount();

    // Case 2: position > 9 (modifierPressed=true to isolate the position guard)
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="card-10">
          <SessionCard cardId="card-10" onRemove={vi.fn()} position={10} modifierPressed={true} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.queryByText(/^⌘/)).toBeNull();
  });

  it("renders the NEEDS REVIEW label when needsReview prop is true", () => {
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} needsReview={true} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("NEEDS REVIEW")).toBeInTheDocument();
  });

  it("does not render the NEEDS REVIEW label when needsReview is false or absent", () => {
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} needsReview={false} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.queryByText("NEEDS REVIEW")).toBeNull();
  });

  it("applies orange-themed left-border accent when needsReview is true", () => {
    const { container: containerTrue } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} needsReview={true} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(containerTrue.querySelector('[data-needs-review="true"]')).not.toBeNull();

    const { container: containerFalse } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} needsReview={false} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(containerFalse.querySelector('[data-needs-review="false"]')).not.toBeNull();
  });

  it("prop overrides context for needsReview", () => {
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "override-test",
      workingDirectory: "/some/path",
      needsReview: false,
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="override-card">
          <SessionCard
            cardId="override-card"
            onRemove={vi.fn()}
            sessionContext={sessionCtx}
            needsReview={true}
          />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("NEEDS REVIEW")).toBeInTheDocument();
  });

  it("derives needsReview from sessionContext when prop is omitted", () => {
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "derive-test",
      workingDirectory: "/some/path",
      needsReview: true,
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="derive-card">
          <SessionCard cardId="derive-card" onRemove={vi.fn()} sessionContext={sessionCtx} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("NEEDS REVIEW")).toBeInTheDocument();
  });

  it("subtitle omits separator when repo is absent", () => {
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "no-repo-slug",
      workingDirectory: "/some/path",
      branch: "feat/x",
      repo: undefined,
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="no-repo-card">
          <SessionCard cardId="no-repo-card" onRemove={vi.fn()} sessionContext={sessionCtx} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.getByText("feat/x")).toBeInTheDocument();
    expect(screen.queryByText(/—/)).toBeNull();
  });

  it("subtitle is empty when both repo and branch are absent", () => {
    const sessionCtx = {
      sessionTs: "20260425-120000",
      slug: "no-repo-no-branch",
      workingDirectory: "/some/path",
      repo: undefined,
      branch: undefined,
    };
    renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value="empty-sub-card">
          <SessionCard cardId="empty-sub-card" onRemove={vi.fn()} sessionContext={sessionCtx} />
        </Tabs.Tab>
      </Tabs>,
    );
    expect(screen.queryByText(/—/)).toBeNull();
    // Slug must still render
    expect(screen.getByText("no-repo-no-branch")).toBeInTheDocument();
  });

  // ── Badge-slot height tests (Step 8) ──────────────────────────────────────

  it("badge slot is always rendered even when no badges are present", () => {
    // Fixture 3: no prNumber, no issueNumber
    const { container } = renderInTabs(CARD_ID_F3);
    const slot = container.querySelector('[data-testid="badge-slot"]');
    expect(slot).not.toBeNull();
    expect(screen.queryByRole("img", { name: "Pull request" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Issue" })).toBeNull();
  });

  it("badge slot is rendered when badges are present", () => {
    // Fixture 0: prNumber=42, issueNumber=17
    const { container } = renderInTabs(CARD_ID_F0);
    const slot = container.querySelector('[data-testid="badge-slot"]');
    expect(slot).not.toBeNull();
    expect(screen.getByRole("img", { name: "Pull request" })).toBeInTheDocument();
  });

  it("badge slot reserves constant height whether or not PR/issue badges are present", () => {
    // Fixture 3: no badges
    const { container: containerNoBadges } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F3}>
          <SessionCard cardId={CARD_ID_F3} onRemove={vi.fn()} />
        </Tabs.Tab>
      </Tabs>,
    );
    const slotNoBadges = containerNoBadges.querySelector('[data-testid="badge-slot"]');
    expect(slotNoBadges).not.toBeNull();
    expect((slotNoBadges as HTMLElement).style.minHeight).not.toBe("");

    // Fixture 0: has badges
    const { container: containerWithBadges } = renderWithProviders(
      <Tabs value={null} onChange={() => {}} orientation="vertical">
        <Tabs.Tab value={CARD_ID_F0}>
          <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} />
        </Tabs.Tab>
      </Tabs>,
    );
    const slotWithBadges = containerWithBadges.querySelector('[data-testid="badge-slot"]');
    expect(slotWithBadges).not.toBeNull();
    expect((slotWithBadges as HTMLElement).style.minHeight).not.toBe("");
  });

  // ── Close button hover-reveal tests (Step 9) ──────────────────────────────

  describe("close button hover-reveal", () => {
    it('outer Box has data-hovered="false" by default', () => {
      const { container } = renderInTabs(CARD_ID_F0);
      const card = container.querySelector("[data-active]") as Element;
      expect(card.getAttribute("data-hovered")).toBe("false");
    });

    it('outer Box has data-hovered="true" after hovering the card', () => {
      const { container } = renderInTabs(CARD_ID_F0);
      const card = container.querySelector("[data-active]") as Element;
      // Use fireEvent.mouseEnter to trigger the React onMouseEnter handler directly,
      // bypassing user-event's pointer-event checks (the absolutely-positioned close
      // button has pointer-events:none which would block user.hover traversal).
      fireEvent.mouseEnter(card);
      expect(card.getAttribute("data-hovered")).toBe("true");
    });

    it('outer Box has data-hovered="false" after unhovering the card', () => {
      const { container } = renderInTabs(CARD_ID_F0);
      const card = container.querySelector("[data-active]") as Element;
      fireEvent.mouseEnter(card);
      expect(card.getAttribute("data-hovered")).toBe("true");
      fireEvent.mouseLeave(card);
      expect(card.getAttribute("data-hovered")).toBe("false");
    });

    it("close button becomes visible on keyboard focus (data-hovered=true)", () => {
      const { container } = renderInTabs(CARD_ID_F0);
      const card = container.querySelector("[data-active]") as Element;
      const btn = screen.getByRole("button", { name: /Remove card/ });
      fireEvent.focus(btn);
      expect(card.getAttribute("data-hovered")).toBe("true");
      fireEvent.blur(btn);
      expect(card.getAttribute("data-hovered")).toBe("false");
    });

    it("close button is keyboard-activatable when hidden by default", async () => {
      const onRemove = vi.fn();
      const user = userEvent.setup();
      const { container } = renderWithProviders(
        <Tabs value={null} onChange={() => {}} orientation="vertical">
          <Tabs.Tab value={CARD_ID_F0}>
            <SessionCard cardId={CARD_ID_F0} onRemove={onRemove} />
          </Tabs.Tab>
        </Tabs>,
      );
      const card = container.querySelector("[data-active]") as Element;
      // Precondition: confirms the "when hidden by default" part of the test name.
      expect(card.getAttribute("data-hovered")).toBe("false");
      const btn = screen.getByRole("button", { name: /Remove card/ });
      btn.focus();
      await user.keyboard("{Enter}");
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("keyboard Tab into card reveals the close button via focus handler", async () => {
      const user = userEvent.setup();
      const { container } = renderWithProviders(
        <div>
          {/* Sentinel focusable element so Tab has somewhere to start from */}
          <button type="button">sentinel</button>
          <Tabs value={null} onChange={() => {}} orientation="vertical">
            <Tabs.Tab value={CARD_ID_F0}>
              <SessionCard cardId={CARD_ID_F0} onRemove={vi.fn()} />
            </Tabs.Tab>
          </Tabs>
        </div>,
      );

      const card = container.querySelector("[data-active]") as Element;
      // Precondition: no interaction has occurred yet.
      expect(card.getAttribute("data-hovered")).toBe("false");

      // Tab past the sentinel and any intervening focusable elements until we
      // land on the close button (aria-label matches "Remove card …").
      const closeBtn = screen.getByRole("button", { name: /Remove card/ });
      let tabCount = 0;
      while (document.activeElement !== closeBtn && tabCount < 20) {
        await user.tab();
        tabCount++;
      }
      expect(document.activeElement).toBe(closeBtn);

      // Once the close button has focus, the onFocus handler must have fired
      // and flipped hovered to true, making the button visible.
      expect(card.getAttribute("data-hovered")).toBe("true");
    });
  });
});
