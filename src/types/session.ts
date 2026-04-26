export interface SessionMeta {
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
