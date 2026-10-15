// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/ui";
import { useDismiss, type DismissOptions } from "./dismiss";

/** A trigger with its popover; `onClose` is recorded besides closing it. */
function Popover({ name, opts = {}, onClose = () => {}, initiallyOpen = true }: { name: string; opts?: Omit<DismissOptions, "inside" | "returnFocus">; onClose?: () => void; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    () => {
      onClose();
      setOpen(false);
    },
    { inside: [panel, trigger], returnFocus: trigger, ...opts },
  );
  return (
    <div>
      <button ref={trigger} type="button" onClick={() => setOpen((o) => !o)}>
        {name} trigger
      </button>
      {open && (
        <div ref={panel} data-testid={`${name}-panel`} style={{ overflow: "auto" }}>
          <button type="button">{name} item</button>
        </div>
      )}
    </div>
  );
}

describe("useDismiss", () => {
  it("a press outside closes; presses on the popover or its trigger do not", () => {
    render(
      <>
        <Popover name="a" />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.pointerDown(screen.getByText("a item"));
    fireEvent.pointerDown(screen.getByText("a trigger"));
    expect(screen.getByTestId("a-panel")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(screen.queryByTestId("a-panel")).toBeNull();
  });

  it("content that stops propagation cannot keep it open (capture phase)", () => {
    render(
      <>
        <Popover name="a" />
        <div onPointerDown={(e) => e.stopPropagation()}>
          <span>stopper</span>
        </div>
      </>,
    );
    fireEvent.pointerDown(screen.getByText("stopper"));
    expect(screen.queryByTestId("a-panel")).toBeNull();
  });

  it("Escape closes and gives the focus back to the trigger", () => {
    render(<Popover name="a" />);
    screen.getByText("a item").focus();
    fireEvent.keyDown(screen.getByText("a item"), { key: "Escape" });
    expect(screen.queryByTestId("a-panel")).toBeNull();
    expect(screen.getByText("a trigger")).toHaveFocus();
  });

  it("Escape closes only the innermost open layer, and leaves an Escape handled inside alone", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Both() {
      const [second, setSecond] = useState(false);
      return (
        <>
          <Popover name="outer" onClose={outer} />
          <button type="button" onClick={() => setSecond(true)}>
            open inner
          </button>
          {second && <Popover name="inner" onClose={inner} />}
        </>
      );
    }
    render(<Both />);
    fireEvent.click(screen.getByText("open inner"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => void document.body.dispatchEvent(handled));
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("Escape in a popover inside a dialog closes the popover, not the dialog", () => {
    const dialogClosed = vi.fn();
    render(
      <Dialog title="Status" open onClose={dialogClosed}>
        <Popover name="emoji" />
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByText("emoji item"), { key: "Escape" });
    expect(screen.queryByTestId("emoji-panel")).toBeNull();
    expect(dialogClosed).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(dialogClosed).toHaveBeenCalledTimes(1);
  });

  it("closeOnScroll: scrolling outside or resizing closes, scrolling inside does not", () => {
    render(
      <>
        <Popover name="a" opts={{ closeOnScroll: true }} />
        <Popover name="b" opts={{ closeOnScroll: true }} />
      </>,
    );
    fireEvent.scroll(screen.getByTestId("a-panel"));
    expect(screen.getByTestId("a-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("b-panel")).toBeNull();
    fireEvent(window, new Event("resize"));
    expect(screen.queryByTestId("a-panel")).toBeNull();
  });

  it("deferred: the press that opened it does not close it; ignore keeps chosen outside events", async () => {
    vi.useFakeTimers();
    const ignore = vi.fn((e: Event) => e.type === "contextmenu");
    render(
      <>
        <Popover name="a" opts={{ deferred: true, contextMenu: true, ignore, closeOnBlur: true }} />
        <p>elsewhere</p>
      </>,
    );
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(screen.getByTestId("a-panel")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(0));
    fireEvent.contextMenu(screen.getByText("elsewhere"));
    expect(screen.getByTestId("a-panel")).toBeInTheDocument();
    fireEvent(window, new Event("blur"));
    expect(screen.queryByTestId("a-panel")).toBeNull();
    vi.useRealTimers();
  });
});
