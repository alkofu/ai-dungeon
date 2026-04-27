import type { ClaudeContext } from "../../types/session";

export const CLAUDE_CONTEXT_FIXTURES: ClaudeContext[] = [
  {
    sessionTs: "20260425-120000",
    slug: "refactor-auth-flow",
    workingDirectory: "~/projects/ai-dungeon",
    branch: "feat/session-card",
    prNumber: 42,
    issueNumber: 17,
    repo: { owner: "acme-corp", name: "ai-dungeon" },
  },
  {
    sessionTs: "20260424-093015",
    slug: "fix-terminal-resize",
    workingDirectory: "/home/user/work/backend-service/src/handlers",
    branch: "fix/terminal-resize",
    prNumber: 7,
    repo: { owner: "acme-corp", name: "backend-service" },
  },
  {
    sessionTs: "20260423-141200",
    slug: "add-issue-tracker",
    workingDirectory: "/Users/alex/code/frontend",
    branch: "feat/issue-tracker",
    issueNumber: 99,
    repo: { owner: "open-source-org", name: "frontend" },
  },
  {
    sessionTs: "20260422-080530",
    slug: "chore-update-deps",
    workingDirectory: "~/personal/side-project",
    branch: "chore/update-deps",
    repo: { owner: "alkofu", name: "side-project" },
  },
];

/**
 * Returns a deterministic ClaudeContext fixture for the given cardId.
 * Uses a char-code sum mod fixtures.length mapping — note this introduces a
 * cosmetic bias toward lower-indexed fixtures for sequential single-char IDs,
 * which is acceptable for mock data.
 */
export function getMockClaudeContext(cardId: string): ClaudeContext {
  let sum = 0;
  for (let i = 0; i < cardId.length; i++) {
    sum += cardId.charCodeAt(i);
  }
  return CLAUDE_CONTEXT_FIXTURES[sum % CLAUDE_CONTEXT_FIXTURES.length];
}
