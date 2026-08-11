import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "../src/App";
import { useI18n } from "../src/i18n";

// The Pixi map mounts a WebGL/Canvas Application on the Cockpit tab, which
// happy-dom cannot back (no real GPU/canvas context) — see task-11 brief:
// "Pixi/DOM layer excluded from vitest". App's tab-switching/i18n behavior
// under test here doesn't depend on what's inside the Cockpit panel, so the
// map is stubbed out.
vi.mock("../src/map/PixiMap", () => ({
  default: () => <div data-testid="pixi-map-stub" />,
}));

describe("App language switching (render-based)", () => {
  beforeEach(() => {
    localStorage.clear();
    useI18n.setState({ lang: "ru" });
  });

  it("re-renders tab labels and the connection chip when the lang switches", () => {
    render(<App />);

    // Sanity: starts in Russian.
    expect(document.body.textContent).toContain("Кокпит");

    fireEvent.click(screen.getByRole("button", { name: "en" }));

    // Tab label (TabBar) must reflect the new lang.
    expect(document.body.textContent).toContain("Cockpit");
    expect(document.body.textContent).not.toContain("Кокпит");

    // Connection chip (ConnectionChip) must reflect the new lang too.
    expect(document.body.textContent).toContain("Connection: reconnecting");
  });
});
