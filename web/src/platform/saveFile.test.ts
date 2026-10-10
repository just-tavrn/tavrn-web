// SPDX-License-Identifier: Apache-2.0
/** Downloads (docs/DESKTOP.md "Downloads"): one entry point, the browser's anchor download or the shell's save dialog. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSaveFile, SAVE_CHUNK_BYTES } from "./files";
import { createTauriSaveFile, type ShellCall } from "./tauriFiles";
import { saveFile } from "./saveFile";
import { resetPlatform, setPlatform } from "./index";
import { browserPlatform } from "./browser";
import { useToasts } from "../stores/toasts";

const MiB = 1024 * 1024;

/** A fake shell: records every call, answers from `answers`. */
function shell(answers: Partial<Record<string, (args: unknown) => unknown>> = {}) {
  const calls: Array<{ cmd: string; args: unknown; headers?: Record<string, string> }> = [];
  const call: ShellCall = async (cmd, args, options) => {
    calls.push({ cmd, args, headers: options?.headers as Record<string, string> | undefined });
    const answer = answers[cmd];
    if (answer) return answer(args);
    if (cmd === "save_file_begin") return { status: "ready", id: "7" };
    if (cmd === "save_file_end") return { path: "/home/alice/Downloads/plan.pdf", folder: "Downloads" };
    return null;
  };
  return { calls, call };
}

describe("browser download", () => {
  let created: Blob[];
  let clicked: Array<{ href: string; download: string }>;
  beforeEach(() => {
    created = [];
    clicked = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), `blob:test/${created.length}`), revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetPlatform();
    useToasts.setState({ toasts: [] });
  });

  it("saves through an anchor with the file's name and the given type, and leaves no anchor behind", async () => {
    const out = await browserSaveFile({ name: "notes.txt", data: new Uint8Array([104, 105]), mime: "application/octet-stream" });
    expect(out).toEqual({ status: "started" });
    expect(clicked).toEqual([{ href: "blob:test/1", download: "notes.txt" }]);
    expect(created[0]!.type).toBe("application/octet-stream");
    expect(created[0]!.size).toBe(2);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  it("names a file without a name 'download'", async () => {
    await browserSaveFile({ name: "", data: new Blob(["x"]) });
    expect(clicked[0]!.download).toBe("download");
  });

  it("is what the entry point uses in the browser, without a toast", async () => {
    setPlatform(browserPlatform);
    const out = await saveFile({ name: "a.json", data: new Blob(["{}"]), mime: "application/json" });
    expect(out.status).toBe("started");
    expect(clicked).toHaveLength(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});

describe("desktop save", () => {
  afterEach(() => {
    resetPlatform();
    useToasts.setState({ toasts: [] });
  });

  it("asks the shell for a target, streams the blob in 4 MiB chunks and finishes", async () => {
    expect(SAVE_CHUNK_BYTES).toBe(4 * MiB);
    const { calls, call } = shell();
    const data = new Uint8Array(9 * MiB + 3);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const out = await createTauriSaveFile(call)({ name: "plan.pdf", data: new Blob([data]), mime: "application/pdf" });
    expect(out).toMatchObject({ status: "saved", name: "plan.pdf", path: "/home/alice/Downloads/plan.pdf", folder: "Downloads" });
    expect(calls.map((c) => c.cmd)).toEqual(["save_file_begin", "save_file_chunk", "save_file_chunk", "save_file_chunk", "save_file_end"]);
    expect(calls[0]!.args).toEqual({ name: "plan.pdf", mime: "application/pdf", size: 9 * MiB + 3 });
    const chunks = calls.filter((c) => c.cmd === "save_file_chunk");
    // Raw IPC bodies (no JSON arrays), the save's id in a header.
    for (const c of chunks) {
      expect(c.args).toBeInstanceOf(Uint8Array);
      expect(c.headers).toEqual({ "x-tavrn-save": "7" });
    }
    expect(chunks.map((c) => (c.args as Uint8Array).length)).toEqual([4 * MiB, 4 * MiB, MiB + 3]);
    const joined = new Uint8Array(data.length);
    let at = 0;
    for (const c of chunks) {
      joined.set(c.args as Uint8Array, at);
      at += (c.args as Uint8Array).length;
    }
    expect(at).toBe(data.length);
    expect(Buffer.from(joined).equals(Buffer.from(data))).toBe(true);
    expect(calls[4]!.args).toEqual({ id: "7" });
  });

  it("accepts bytes as well as a blob, and an empty file", async () => {
    const { calls, call } = shell();
    await createTauriSaveFile(call)({ name: "empty.txt", data: new Uint8Array(0) });
    expect(calls.map((c) => c.cmd)).toEqual(["save_file_begin", "save_file_end"]);
    expect(calls[0]!.args).toEqual({ name: "empty.txt", mime: "application/octet-stream", size: 0 });
  });

  it("returns 'cancelled' without writing when the user closes the dialog", async () => {
    const { calls, call } = shell({ save_file_begin: () => ({ status: "cancelled" }) });
    const out = await createTauriSaveFile(call)({ name: "plan.pdf", data: new Blob(["x"]) });
    expect(out).toEqual({ status: "cancelled" });
    expect(calls.map((c) => c.cmd)).toEqual(["save_file_begin"]);
  });

  it("aborts the save when a chunk fails and passes the error on", async () => {
    const { calls, call } = shell({
      save_file_chunk: () => {
        throw "download.write_failed";
      },
    });
    await expect(createTauriSaveFile(call)({ name: "plan.pdf", data: new Blob(["xyz"]) })).rejects.toBe("download.write_failed");
    expect(calls.map((c) => c.cmd)).toEqual(["save_file_begin", "save_file_chunk", "save_file_abort"]);
    expect(calls[2]!.args).toEqual({ id: "7" });
  });

  it("aborts the save when reading the blob fails", async () => {
    const { calls, call } = shell();
    const broken = new Blob(["xyz"]);
    vi.spyOn(broken, "slice").mockImplementation(() => {
      throw new Error("gone");
    });
    await expect(createTauriSaveFile(call)({ name: "plan.pdf", data: broken })).rejects.toThrow("gone");
    expect(calls.map((c) => c.cmd)).toEqual(["save_file_begin", "save_file_abort"]);
  });

  it("aborts when finishing fails", async () => {
    const { calls, call } = shell({
      save_file_end: () => {
        throw "download.incomplete";
      },
    });
    await expect(createTauriSaveFile(call)({ name: "a.txt", data: new Blob(["a"]) })).rejects.toBe("download.incomplete");
    expect(calls.map((c) => c.cmd).at(-1)).toBe("save_file_abort");
  });

  it("reveals the saved file by its id, never by a path", async () => {
    const { calls, call } = shell();
    const out = await createTauriSaveFile(call)({ name: "a.txt", data: new Blob(["a"]) });
    if (out.status !== "saved") throw new Error("not saved");
    await out.reveal?.();
    expect(calls.at(-1)).toEqual({ cmd: "save_file_reveal", args: { id: "7" }, headers: undefined });
  });

  it("the entry point shows 'saved to' with a 'show in folder' action after a desktop save", async () => {
    const { calls, call } = shell();
    setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, saveFile: createTauriSaveFile(call) });
    await saveFile({ name: "plan.pdf", data: new Blob(["x"]) });
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "info", title: "Gespeichert in Downloads", detail: "plan.pdf", testId: "download-saved" });
    expect(toasts[0]!.action?.label).toBe("Im Ordner zeigen");
    toasts[0]!.action!.run();
    await vi.waitFor(() => expect(calls.at(-1)?.cmd).toBe("save_file_reveal"));
  });

  it("the entry point shows nothing when the user cancelled", async () => {
    const { call } = shell({ save_file_begin: () => ({ status: "cancelled" }) });
    setPlatform({ ...browserPlatform, kind: "desktop", isDesktop: true, saveFile: createTauriSaveFile(call) });
    expect((await saveFile({ name: "plan.pdf", data: new Blob(["x"]) })).status).toBe("cancelled");
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
