import { renderWithProviders } from "../../test-utils/render";
import { screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  it("renders the CWD when provided", () => {
    renderWithProviders(<StatusBar context={{ cwd: "/foo/bar", git: null }} />);
    expect(screen.getByTestId("status-bar-cwd")).toHaveTextContent("/foo/bar");
  });

  it("renders … when CWD is null", () => {
    renderWithProviders(<StatusBar context={{ cwd: null, git: null }} />);
    expect(screen.getByTestId("status-bar-cwd")).toHaveTextContent("…");
  });

  it("renders repo · branch when git is provided", () => {
    renderWithProviders(
      <StatusBar context={{ cwd: "/foo", git: { repo: "my-repo", branch: "main" } }} />,
    );
    expect(screen.getByTestId("status-bar-git")).toHaveTextContent("my-repo · main");
  });

  it("renders nothing on the right when git is null", () => {
    renderWithProviders(<StatusBar context={{ cwd: "/foo", git: null }} />);
    expect(screen.queryByTestId("status-bar-git")).toBeNull();
  });
});
