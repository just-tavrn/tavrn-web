// SPDX-License-Identifier: Apache-2.0
/**
 * The whiteboard's frame: the full page (the route, a maximized stage tile) keeps its header and the canvas's
 * toolbars out of the system bars and notches through the safe-area variables (styles.css, docs/ANDROID.md
 * "System bars"), like the other full-screen views; embedded in a stage tile it fills its parent without them.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/render";

const controller = vi.hoisted(() => ({ role: null, session: null, joined: false, ended: false, views: 0, elements: new Map(), participants: new Map(), leave: vi.fn() }));
vi.mock("./store", () => ({ useWhiteboardController: () => controller, useBoardContent: () => 0, loadDraft: async () => null }));

const { WhiteboardSession } = await import("./WhiteboardSession");

function renderSession(layout?: "fullscreen" | "embedded") {
  const ctx = { domain: "n.test", conversationId: "C", api: {} as never, home: true, encrypted: false };
  renderWithProviders(<WhiteboardSession ctx={ctx as never} title="general" backTo="/" canOpen canModerate={false} ready={false} members={[]} shareTargets={[]} layout={layout} />);
  return screen.getByTestId("whiteboard");
}

const SAFE = ["pt-[var(--safe-top)]", "pr-[var(--safe-right)]", "pb-[var(--safe-bottom)]", "pl-[var(--safe-left)]"];

describe("the whiteboard's frame", () => {
  it("as the full page pads itself with all four safe areas", () => {
    const frame = renderSession();
    expect(frame).toHaveClass("fixed", "inset-0", ...SAFE);
  });

  it("maximized (layout fullscreen) as well", () => {
    expect(renderSession("fullscreen")).toHaveClass(...SAFE);
  });

  it("embedded in a stage tile it fills its parent without safe-area padding", () => {
    const frame = renderSession("embedded");
    expect(frame).toHaveClass("relative", "h-full", "w-full");
    for (const c of SAFE) expect(frame).not.toHaveClass(c);
  });
});

describe("renaming a scene", () => {
  it("is a field in the scene's row, not the browser's prompt: Enter saves the trimmed name, Escape cancels", async () => {
    const { SceneRename } = await import("./WhiteboardSession");
    const prompt = vi.spyOn(window, "prompt");
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { fireEvent } = await import("@testing-library/react");
    renderWithProviders(<SceneRename name="Raid plan" busy={false} onSave={onSave} onCancel={onCancel} />);
    const field = screen.getByRole("textbox");
    expect(field).toHaveValue("Raid plan");
    fireEvent.change(field, { target: { value: "  Raid plan 2  " } });
    fireEvent.submit(screen.getByTestId("scene-rename-form"));
    expect(onSave).toHaveBeenCalledWith("Raid plan 2");
    // An empty name cannot be saved.
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.submit(screen.getByTestId("scene-rename-form"));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });
});
