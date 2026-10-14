// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The voice header's session timer and status line (VOICE.md §5, §2a; docs/CLIENT.md "Voice channels").

const api = vi.hoisted(() => ({ channels: { update: vi.fn(async (_r: string, _c: string, req: { status?: string | null }) => ({ id: "C", status: req.status })) } }));
vi.mock("../../components/NodeScope", () => ({ useNode: () => ({ api, domain: "n.test", me: { id: "u-me" } }) }));

const { SessionTimer, VoiceStatusLine, elapsedSince, formatElapsed } = await import("./VoiceHeaderMeta");
const { useToasts } = await import("../../stores/toasts");

describe("formatElapsed", () => {
  it("renders hh:mm:ss and keeps counting hours past a day", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
    expect(formatElapsed(5_000)).toBe("00:00:05");
    expect(formatElapsed(65_000)).toBe("00:01:05");
    expect(formatElapsed(3_600_000 + 61_000)).toBe("01:01:01");
    expect(formatElapsed(27 * 3_600_000 + 1_000)).toBe("27:00:01");
    expect(formatElapsed(-5)).toBe("00:00:00");
    expect(formatElapsed(Number.NaN)).toBe("00:00:00");
    expect(elapsedSince("not a date", 5)).toBe(0);
    expect(elapsedSince("2026-10-14T12:00:00.000Z", Date.parse("2026-10-14T12:00:03.000Z"))).toBe(3000);
  });
});

describe("SessionTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:59.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("is hidden while the channel is empty", () => {
    render(<SessionTimer startedAt={null} />);
    expect(screen.queryByTestId("voice-session-timer")).toBeNull();
  });

  it("ticks every second and announces the running time at most once a minute", () => {
    render(<SessionTimer startedAt="2026-10-14T12:00:00.000Z" />);
    const timer = screen.getByTestId("voice-session-timer");
    expect(timer).toHaveTextContent("00:00:59");
    expect(timer).toHaveAttribute("title", "Sitzung läuft seit 00:00:59");
    const live = screen.getByTestId("voice-session-announce");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Sprachsitzung läuft seit 00:00");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer).toHaveTextContent("00:01:00");
    expect(live).toHaveTextContent("Sprachsitzung läuft seit 00:01");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(timer).toHaveTextContent("00:01:30");
    expect(live).toHaveTextContent("Sprachsitzung läuft seit 00:01", { normalizeWhitespace: true });
    // The digits are decoration for screen readers; the live text is the announcement.
    expect(timer.querySelector("[aria-hidden='true']")).toHaveTextContent("00:01:30");
  });
});

describe("VoiceStatusLine", () => {
  beforeEach(() => {
    api.channels.update.mockClear();
    useToasts.setState({ toasts: [] });
  });

  it("shows the status to everybody and nothing at all without a status and without the bit", () => {
    const { rerender } = render(<VoiceStatusLine roomId="R" channel={{ id: "C", status: "Raid night" }} canEdit={false} />);
    expect(screen.getByTestId("voice-status")).toHaveTextContent("Raid night");
    expect(screen.queryByTestId("voice-status-edit")).toBeNull();
    rerender(<VoiceStatusLine roomId="R" channel={{ id: "C", status: "" }} canEdit={false} />);
    expect(screen.queryByTestId("voice-status")).toBeNull();
    expect(screen.queryByTestId("voice-status-empty")).toBeNull();
  });

  it("with the bit: a pencil opens the editor, Enter saves the trimmed text, Escape cancels", async () => {
    render(<VoiceStatusLine roomId="R" channel={{ id: "C", status: "" }} canEdit />);
    expect(screen.getByTestId("voice-status-empty")).toHaveTextContent("Status setzen");
    const pencil = screen.getByRole("button", { name: "Kanalstatus bearbeiten" });
    fireEvent.click(pencil);
    const input = screen.getByRole("textbox", { name: "Kanalstatus" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", "128");
    expect(screen.getByTestId("voice-status-counter")).toHaveTextContent("0/128");
    fireEvent.change(input, { target: { value: "  Raid night " } });
    expect(screen.getByTestId("voice-status-counter")).toHaveTextContent("13/128");
    expect(input).toHaveAccessibleDescription(/13 von 128 Zeichen\. Enter speichert, Escape bricht ab/);
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => undefined);
    expect(api.channels.update).toHaveBeenCalledWith("R", "C", { status: "Raid night" });
    expect(screen.queryByTestId("voice-status-editor")).toBeNull();

    // Escape throws the draft away without a request; an unchanged text saves nothing either.
    fireEvent.click(screen.getByRole("button", { name: "Kanalstatus bearbeiten" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Kanalstatus" }), { target: { value: "Nope" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Kanalstatus" }), { key: "Escape" });
    expect(screen.queryByTestId("voice-status-editor")).toBeNull();
    expect(api.channels.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Kanalstatus bearbeiten" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Kanalstatus" }), { key: "Enter" });
    await act(async () => undefined);
    expect(api.channels.update).toHaveBeenCalledTimes(1);
  });

  it("a refused save stays in the editor and shows the error", async () => {
    api.channels.update.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { problem: { code: "channel.status_forbidden", title: "Forbidden", detail: "Missing permission" } }));
    render(<VoiceStatusLine roomId="R" channel={{ id: "C", status: "Old" }} canEdit />);
    fireEvent.click(screen.getByRole("button", { name: "Kanalstatus bearbeiten" }));
    const input = screen.getByRole("textbox", { name: "Kanalstatus" });
    expect(input).toHaveValue("Old");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => undefined);
    expect(screen.getByTestId("voice-status-editor")).toBeInTheDocument();
    expect(useToasts.getState().toasts).toHaveLength(1);
  });
});
