import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { Tabs } from "@mantine/core";
import { renderWithProviders } from "../../test-utils/render";
import { SessionCard } from "./SessionCard";
import { getMockSessionContext, SESSION_CONTEXT_FIXTURES } from "./sessionContext.mock";

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
    renderInTabs("abcdefgh-1234-5678-abcd-ef1234567890", onRemove);

    const btn = screen.getByRole("button", { name: "Remove card abcdefgh" });
    expect(btn).toBeInTheDocument();

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

  it("7. tooltip on working-directory tail shows the full path", async () => {
    const user = userEvent.setup();
    // Use fixture 1: full path "/home/user/work/backend-service/src/handlers"
    // visible tail: "src/handlers"
    renderInTabs(CARD_ID_F1);

    // The visible tail differs from the full path — hover the tail text
    const trigger = screen.getByText("src/handlers");
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(SESSION_CONTEXT_FIXTURES[1].workingDirectory);
  });

  it("8. working-directory visible text is last 1-2 segments", () => {
    // Fixture 1: "/home/user/work/backend-service/src/handlers" → "src/handlers"
    renderInTabs(CARD_ID_F1);
    expect(screen.getByText("src/handlers")).toBeInTheDocument();
    expect(screen.queryByText(SESSION_CONTEXT_FIXTURES[1].workingDirectory)).toBeNull();
  });

  it("9a. PR badge shows 'PR —' when prNumber is undefined", () => {
    // Fixture 2 has no prNumber
    renderInTabs(CARD_ID_F2);
    expect(screen.getByText("PR —")).toBeInTheDocument();
  });

  it("9d. PR badge renders the pull-request icon when prNumber is undefined", () => {
    // Fixture 2 has no prNumber — icon must still be present in the empty state
    renderInTabs(CARD_ID_F2);
    expect(screen.getByRole("img", { name: "Pull request" })).toBeInTheDocument();
  });

  it("9b. PR badge shows 'PR #n' when prNumber is defined", () => {
    // Fixture 0 has prNumber: 42
    renderInTabs(CARD_ID_F0);
    expect(screen.getByText("PR #42")).toBeInTheDocument();
  });

  it("9c. PR badge renders the pull-request icon when prNumber is defined", () => {
    // Fixture 0 has prNumber: 42
    renderInTabs(CARD_ID_F0);
    expect(screen.getByRole("img", { name: "Pull request" })).toBeInTheDocument();
  });

  it("10a. Issue badge shows 'Issue —' when issueNumber is undefined", () => {
    // Fixture 1 has no issueNumber
    renderInTabs(CARD_ID_F1);
    expect(screen.getByText("Issue —")).toBeInTheDocument();
  });

  it("10d. Issue badge renders the issue icon when issueNumber is undefined", () => {
    // Fixture 1 has no issueNumber — icon must still be present in the empty state
    renderInTabs(CARD_ID_F1);
    expect(screen.getByRole("img", { name: "Issue" })).toBeInTheDocument();
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

  it("11. third placeholder badge with text '—' is always present", () => {
    renderInTabs(CARD_ID_F3);
    // Fixture 3 has neither PR nor Issue, so only the standalone '—' badge remains
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("11b. placeholder badge renders no icon", () => {
    // Fixture 3 has neither PR nor Issue
    const { container } = renderInTabs(CARD_ID_F3);
    const badges = container.querySelectorAll(".mantine-Badge-root");
    expect(badges).toHaveLength(3);
    const thirdBadge = badges[2];
    expect(thirdBadge.querySelectorAll('[role="img"]')).toHaveLength(0);
    expect(thirdBadge.textContent).toContain("—");
  });

  it("mock module is deterministic: same cardId returns deeply equal objects", () => {
    const id = "test-determinism-check";
    const a = getMockSessionContext(id);
    const b = getMockSessionContext(id);
    expect(a).toEqual(b);
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
});
