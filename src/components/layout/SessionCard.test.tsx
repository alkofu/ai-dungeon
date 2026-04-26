import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { Tabs } from "@mantine/core";
import { renderWithProviders } from "../../test-utils/render";
import { SessionCard } from "./SessionCard";
import { getMockSessionMeta, SESSION_META_FIXTURES } from "./sessionMeta.mock";
import type { SessionContext } from "../../App";

const NULL_CONTEXT: SessionContext = { cwd: null, git: null };

// Cards 1–5 are wrapped in Tabs context matching production rendering.
function renderInTabs(cardId: string, onRemove = vi.fn(), context: SessionContext = NULL_CONTEXT) {
  return renderWithProviders(
    <Tabs value={null} onChange={() => {}} orientation="vertical">
      <Tabs.Tab value={cardId}>
        <SessionCard cardId={cardId} onRemove={onRemove} context={context} />
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
    expect(screen.getByText(SESSION_META_FIXTURES[0].slug)).toBeInTheDocument();
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

  it("6. tooltip on path-tail shows the full cwd when git is present", async () => {
    const user = userEvent.setup();
    const context: SessionContext = {
      cwd: "/home/user/work/backend-service/src/handlers",
      git: { repo: "backend-service", branch: "fix/terminal-resize" },
    };
    renderInTabs(CARD_ID_F0, vi.fn(), context);

    const trigger = screen.getByText("src/handlers");
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("/home/user/work/backend-service/src/handlers");
  });

  it("7. tooltip on path-tail shows the full cwd when git is null", async () => {
    const user = userEvent.setup();
    const context: SessionContext = {
      cwd: "/home/user/work/backend-service/src/handlers",
      git: null,
    };
    renderInTabs(CARD_ID_F1, vi.fn(), context);

    const trigger = screen.getByText("src/handlers");
    await user.hover(trigger);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("/home/user/work/backend-service/src/handlers");
  });

  it("8. working-directory visible text is last 1-2 segments", () => {
    const context: SessionContext = {
      cwd: "/home/user/work/backend-service/src/handlers",
      git: null,
    };
    renderInTabs(CARD_ID_F1, vi.fn(), context);
    expect(screen.getByText("src/handlers")).toBeInTheDocument();
    expect(screen.queryByText("/home/user/work/backend-service/src/handlers")).toBeNull();
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

  it("12. row-2 shows repo, branch, and path-tail when git is present", () => {
    const context: SessionContext = {
      cwd: "/home/user/work/backend-service/src/handlers",
      git: { repo: "backend-service", branch: "fix/resize" },
    };
    renderInTabs(CARD_ID_F0, vi.fn(), context);

    expect(screen.getByText("backend-service")).toBeInTheDocument();
    expect(screen.getByText("fix/resize")).toBeInTheDocument();
    expect(screen.getByText("src/handlers")).toBeInTheDocument();
  });

  it("13. row-2 shows only path-tail when git is null (no repo or branch rendered)", () => {
    // Use CARD_ID_F1 (fixture 1, repo: "backend-service") with a cwd whose
    // last two segments do not collide with the repo name ("backend-service"),
    // to avoid false-negative matches.
    const meta = getMockSessionMeta(CARD_ID_F1);
    const context: SessionContext = {
      cwd: "/home/user/work/other-project/src",
      git: null,
    };
    renderInTabs(CARD_ID_F1, vi.fn(), context);

    expect(screen.getByText("other-project/src")).toBeInTheDocument();
    // Repo name must not appear.
    expect(screen.queryByText(meta.repo.name)).toBeNull();
  });

  it("14. row-2 shows … placeholder when cwd is null and git is null", () => {
    renderInTabs(CARD_ID_F0, vi.fn(), { cwd: null, git: null });
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("15. row-2 shows repo : branch • … when cwd is null but git is present", () => {
    const context: SessionContext = {
      cwd: null,
      git: { repo: "my-repo", branch: "main" },
    };
    renderInTabs(CARD_ID_F0, vi.fn(), context);

    expect(screen.getByText("my-repo")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("mock module is deterministic: same cardId returns deeply equal objects", () => {
    const id = "test-determinism-check";
    const a = getMockSessionMeta(id);
    const b = getMockSessionMeta(id);
    expect(a).toEqual(b);
  });
});
