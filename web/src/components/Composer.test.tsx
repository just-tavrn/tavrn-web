// SPDX-License-Identifier: Apache-2.0
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { BUILTIN_COMMANDS } from "../commands/builtin";
import { useComposerPrefs } from "../stores/composerPrefs";

describe("Composer", () => {
  it("the ＋ button is a menu with the file picker, Poll and Date poll where polls may be created", async () => {
    const onPoll = vi.fn();
    const u = userEvent.setup();
    const { rerender } = render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onPoll={onPoll} />);
    const plus = screen.getByRole("button", { name: "Datei oder Umfrage hinzufügen" });
    expect(plus).toHaveAttribute("aria-haspopup", "menu");
    expect(plus).toHaveAttribute("aria-expanded", "false");
    await u.click(plus);
    expect(plus).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(screen.getAllByRole("menuitem").map((x) => x.textContent)).toEqual([expect.stringContaining("Datei anhängen"), expect.stringContaining("Umfrage"), expect.stringContaining("Terminumfrage")]);
    await u.click(screen.getByTestId("plus-date-poll"));
    expect(onPoll).toHaveBeenCalledWith("date");
    expect(menu).not.toBeInTheDocument();
    // Without uploads only the polls; without polls the button picks a file directly.
    rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} onPoll={onPoll} />);
    await u.click(screen.getByRole("button", { name: "Datei oder Umfrage hinzufügen" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await u.keyboard("{Escape}");
    rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach />);
    expect(screen.getByRole("button", { name: "Datei anhängen" })).not.toHaveAttribute("aria-haspopup");
    rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    expect(screen.queryByTestId("composer-plus")).toBeNull();
  });

  it("sends with Enter, not with Shift+Enter, and clears afterwards", async () => {
    const onSend = vi.fn(async () => {});
    const onTyping = vi.fn();
    render(<Composer placeholder="Nachricht" onSend={onSend} onTyping={onTyping} />);
    const u = userEvent.setup();
    const box = screen.getByLabelText("Nachricht");
    await u.type(box, "Zeile 1{Shift>}{Enter}{/Shift}Zeile 2");
    expect(onSend).not.toHaveBeenCalled();
    expect(onTyping).toHaveBeenCalledTimes(1);
    await u.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "Zeile 1\nZeile 2", attachmentIds: [] }));
    expect(box).toHaveValue("");
  });

  it("sends nothing empty and keeps its content on errors", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("kaputt");
    });
    render(<Composer placeholder="Nachricht" onSend={onSend} />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText("Nachricht"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await u.clear(screen.getByLabelText("Nachricht"));
    await u.type(screen.getByLabelText("Nachricht"), "hallo");
    await u.click(screen.getByRole("button", { name: "Senden" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "hallo", attachmentIds: [] }));
    expect(screen.getByLabelText("Nachricht")).toHaveValue("hallo");
  });

  it("is disabled without the write permission", () => {
    render(<Composer placeholder="Nachricht" disabled disabledReason="Kein Schreibrecht" onSend={vi.fn()} />);
    expect(screen.getByLabelText("Nachricht")).toBeDisabled();
    expect(screen.getByText("Kein Schreibrecht")).toBeInTheDocument();
  });
});

describe("Composer: attachments", () => {
  it("uploads files, shows them and sends their IDs along", async () => {
    const onSend = vi.fn(async () => {});
    const onUpload = vi.fn(async (file: File, onProgress: (f: number) => void) => {
      onProgress(1);
      return { id: "01J00000000000000000000000", name: file.name, mime: file.type, size: file.size, sha256: "x" };
    });
    render(<Composer placeholder="Nachricht" onSend={onSend} canAttach onUpload={onUpload} uploadLimitBytes={1000} />);
    const u = userEvent.setup();
    const input = screen.getByLabelText("Datei auswählen") as HTMLInputElement;
    await u.upload(input, new File(["abc"], "a.txt", { type: "text/plain" }));
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeEnabled());
    await u.click(screen.getByRole("button", { name: "Senden" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "", attachmentIds: ["01J00000000000000000000000"] }));
    expect(screen.queryByTestId("pending-uploads")).not.toBeInTheDocument();
  });

  it("marks uploads as spoilers and wraps the selection with Ctrl+Shift+S (design note 4.13)", async () => {
    const onSend = vi.fn(async () => {});
    const onUpload = vi.fn(async (file: File) => ({ id: "01J00000000000000000000000", name: file.name, mime: file.type, size: file.size, sha256: "x" }));
    render(<Composer placeholder="Nachricht" onSend={onSend} canAttach onUpload={onUpload} />);
    const u = userEvent.setup();
    await u.upload(screen.getByLabelText("Datei auswählen") as HTMLInputElement, new File(["abc"], "b.png", { type: "image/png" }));
    const toggle = await screen.findByRole("button", { name: "b.png als Spoiler markieren" });
    await u.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const box = screen.getByLabelText("Nachricht") as HTMLTextAreaElement;
    await u.type(box, "das ende");
    box.setSelectionRange(4, 8);
    await u.keyboard("{Control>}{Shift>}S{/Shift}{/Control}");
    expect(box.value).toBe("das ||ende||");
    // The spoiler button lives in the formatting bar (the "Formatting" toggle shows it).
    await u.click(screen.getByRole("button", { name: "Formatierung" }));
    const spoilerButton = within(screen.getByRole("toolbar", { name: "Formatierung" })).getByRole("button", { name: /^Spoiler/ });
    // An SVG icon, not a block glyph that renders differently per font.
    expect(spoilerButton.querySelector("svg")).not.toBeNull();
    expect(spoilerButton.textContent).not.toContain("\u2592");
    box.setSelectionRange(box.value.length, box.value.length);
    await u.click(spoilerButton);
    expect(box.value).toContain("||||");
    useComposerPrefs.getState().set({ formatBar: false });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Senden" })).toBeEnabled());
    await u.click(screen.getByRole("button", { name: "Senden" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: ["01J00000000000000000000000"], spoilerIds: ["01J00000000000000000000000"] }));
  });

  it("rejects oversized files locally", async () => {
    const onUpload = vi.fn();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} uploadLimitBytes={2} />);
    await userEvent.setup().upload(screen.getByLabelText("Datei auswählen"), new File(["abc"], "gross.bin"));
    expect(await screen.findByText(/Zu groß/)).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Senden" })).toBeDisabled();
  });

  it("shows the node's refusal of an upload in the user's language, not the node's English detail", async () => {
    // Before the node's upload rules are loaded, the node itself refuses the file (problem code upload.type_not_allowed).
    const refusal = Object.assign(new Error("File type application/x-sh is not allowed on this node"), {
      problem: { code: "upload.type_not_allowed", detail: "File type application/x-sh is not allowed on this node" },
    });
    const onUpload = vi.fn(async () => {
      throw refusal;
    });
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} />);
    await userEvent.setup({ applyAccept: false }).upload(screen.getByLabelText("Datei auswählen"), new File(["echo"], "script.sh", { type: "application/x-sh" }));
    expect(await screen.findByText("Dieser Dateityp ist auf diesem Knoten nicht erlaubt")).toBeInTheDocument();
    expect(screen.queryByText(/is not allowed on this node/)).not.toBeInTheDocument();
  });
});

describe("Composer: commands (design note 4.11)", () => {
  const available = BUILTIN_COMMANDS.filter((d) => ["help", "me", "shrug", "timeout"].includes(d.name));

  it("opens the palette with /, filters fuzzily and completes with Enter", async () => {
    const run = vi.fn(async () => {});
    const onSend = vi.fn();
    render(<Composer placeholder="Nachricht" onSend={onSend} commands={{ available, run }} />);
    const u = userEvent.setup();
    const box = screen.getByLabelText("Nachricht");
    await u.type(box, "/");
    expect(screen.getAllByTestId("command-option").map((o) => o.dataset.name)).toEqual(["help", "me", "shrug", "timeout"]);
    await u.type(box, "tmo");
    expect(screen.getAllByTestId("command-option").map((o) => o.dataset.name)).toEqual(["timeout"]);
    await u.keyboard("{Enter}");
    expect(box).toHaveValue("/timeout ");
    expect(screen.getByTestId("command-hint")).toHaveTextContent("/timeout");
    await u.type(box, "@bob{Enter}");
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByTestId("command-error")).toHaveTextContent("Dauer");
    await u.type(box, " 10m zu laut{Enter}");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "timeout" }), { user: "bob", duration: "10m", reason: "zu laut" });
    expect(box).toHaveValue("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("navigates with the arrow keys, closes with Escape and sends unknown commands as text", async () => {
    const run = vi.fn(async () => {});
    const onSend = vi.fn(async () => {});
    render(<Composer placeholder="Nachricht" onSend={onSend} commands={{ available, run }} />);
    const u = userEvent.setup();
    const box = screen.getByLabelText("Nachricht");
    await u.type(box, "/");
    await u.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getAllByTestId("command-option")[2]).toHaveAttribute("aria-selected", "true");
    await u.keyboard("{Escape}");
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    await u.clear(box);
    await u.type(box, "/wetter berlin{Enter}");
    expect(run).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ body: "/wetter berlin" }));
    await u.type(box, "/help{Enter}");
    expect(screen.getByTestId("command-help")).toHaveTextContent("/timeout");
  });
});

describe("Composer: application commands (APPLICATIONS.md §5.4)", () => {
  const weather = (id: string, appName: string, args = true) => ({
    id,
    ref: `node.test/APP${id}/${id}`,
    name: "weather",
    description: `Forecast by ${appName}`,
    args: args
      ? [
          { name: "city", description: "City", type: "string" as const, required: true },
          { name: "units", description: "Units", type: "string" as const, required: false, options: [{ name: "Metric", value: "metric" }, { name: "Imperial", value: "imperial" }] },
        ]
      : [],
    dm_allowed: false,
    source: "app" as const,
    application: { ref: `node.test/APP${id}`, name: appName, bot: `${appName.toLowerCase()}@node.test` },
    qualifier: appName,
  });

  it("binds the picked application command, offers its pick list and refuses an ambiguous name", async () => {
    const run = vi.fn(async () => {});
    const available = [...BUILTIN_COMMANDS.filter((d) => d.name === "help"), weather("C1", "WeatherBot"), weather("C2", "Clima")];
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} commands={{ available, run }} />);
    const u = userEvent.setup();
    const box = screen.getByLabelText("Nachricht");
    await u.type(box, "/wea");
    const options = screen.getAllByTestId("command-option");
    expect(options.map((o) => o.dataset.ref)).toEqual(["node.test/APPC1/C1", "node.test/APPC2/C2"]);
    expect(screen.getAllByTestId("command-qualifier").map((q) => q.textContent)).toEqual(["· WeatherBot", "· Clima"]);
    await u.click(options[1]!);
    expect(box).toHaveValue("/weather ");
    expect(screen.getByTestId("command-hint-app")).toHaveTextContent("Clima");
    await u.type(box, "Rome ");
    expect(screen.getAllByTestId("command-suggestion").map((s) => s.textContent)).toEqual(["Metric (metric)", "Imperial (imperial)"]);
    await u.click(screen.getAllByTestId("command-suggestion")[1]!);
    expect(box).toHaveValue("/weather Rome imperial ");
    await u.keyboard("{Enter}");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "C2" }), { city: "Rome", units: "imperial" });
    // Typed without picking: two applications have the name.
    await u.type(box, "/weather Oslo{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("command-error")).toHaveTextContent("WeatherBot, Clima");
  });
});

describe("Composer: upload categories (PROTOCOL.md §7a)", () => {
  it("shows the allowed categories, filters the file picker and rejects forbidden files locally", async () => {
    const onUpload = vi.fn();
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} uploadPolicy={{ allowed: ["images"], executablesAllowed: false }} />);
    expect(screen.getByTestId("upload-allowed")).toHaveTextContent("Bilder");
    const input = screen.getByLabelText("Datei auswählen") as HTMLInputElement;
    expect(input.accept).toContain("image/*");
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["%PDF-1.7"], "regeln.pdf", { type: "application/pdf" }));
    expect(await screen.findByTestId("upload-error")).toHaveTextContent("Dokumente");
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["MZ"], "setup.exe"));
    expect(await screen.findByText(/Programme und Skripte sind hier nicht erlaubt/)).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("waits for a policy that is still loading before it uploads (a file picked right after opening the channel)", async () => {
    const onUpload = vi.fn();
    let resolve: (p: { allowed: string[]; executablesAllowed: boolean }) => void = () => {};
    const resolveUploadPolicy = vi.fn(() => new Promise<{ allowed: string[]; executablesAllowed: boolean }>((r) => (resolve = r)));
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} resolveUploadPolicy={resolveUploadPolicy} />);
    const input = screen.getByLabelText("Datei auswählen") as HTMLInputElement;
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["Hallo"], "notizen.txt", { type: "text/plain" }));
    expect(resolveUploadPolicy).toHaveBeenCalled();
    resolve({ allowed: ["images"], executablesAllowed: false });
    expect(await screen.findByTestId("upload-error")).toHaveTextContent("Dokumente dürfen hier nicht hochgeladen werden");
    expect(onUpload).not.toHaveBeenCalled();
  });

  it("shows the node's upload.type_forbidden refusal in the user's language", async () => {
    const refusal = (meta: Record<string, unknown>) =>
      Object.assign(new Error("Uploads of the category documents are not allowed here"), {
        problem: { code: "upload.type_forbidden", detail: "Uploads of the category documents are not allowed here", meta },
      });
    const onUpload = vi.fn().mockRejectedValueOnce(refusal({ category: "documents", executable: false })).mockRejectedValueOnce(refusal({ category: "other", executable: true }));
    render(<Composer placeholder="Nachricht" onSend={vi.fn()} canAttach onUpload={onUpload} />);
    const input = screen.getByLabelText("Datei auswählen") as HTMLInputElement;
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["Hallo"], "notizen.txt", { type: "text/plain" }));
    expect(await screen.findByTestId("upload-error")).toHaveTextContent("Dokumente dürfen hier nicht hochgeladen werden");
    await userEvent.setup({ applyAccept: false }).upload(input, new File(["MZ"], "setup.exe"));
    expect(await screen.findByText(/Programme und Skripte sind hier nicht erlaubt/)).toBeInTheDocument();
    expect(screen.queryByText(/not allowed here/)).toBeNull();
  });
});
