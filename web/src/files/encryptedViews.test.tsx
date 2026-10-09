// SPDX-License-Identifier: Apache-2.0
// The views of encrypted files channels: the deletion facts of the channel and room dialogs, "Your files" of a locked
// channel with bulk deletion, the files group of the search and the folder paths of the background sync.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useLocale } from "../i18n";
import type { FileEntry, FilesInfo } from "@tavrn/sdk";
import { useAuth } from "../stores/auth";
import { mockFetch, renderWithProviders } from "../test/render";
import { FilesDeletionFacts, deletionCase } from "./DeleteChannel";
import { YourFilesPanel, deleteOwn } from "./YourFiles";
import { localRows, splitRows } from "../search/combined";
import { FolderPaths } from "../search/filesSync";

const me = { id: "u1", username: "bob", domain: "t.local", address: "bob@t.local", display_name: "Bob", kind: "user", is_node_admin: false, avatar_blob_id: null, created_at: "", email: null, email_verified: false, has_identity_key: true };

const info = (extra: Partial<FilesInfo>): FilesInfo =>
  ({ enabled: true, used_bytes: 3 * 1024 * 1024, limit_bytes: 0, files: 4, folders: 2, max_upload_bytes: 0, backend: "internal", backend_host: "", backend_prefix: "", encrypt_files: false, encrypted: true, can_upload: true, can_manage: true, can_configure: true, allowed_categories: [], executables_allowed: false, ...extra }) as FilesInfo;

const entry = (id: string, kind: "file" | "folder", size: number): FileEntry =>
  ({ id, channel_id: "C1", parent_id: null, kind, name: "", mime: "", size, sha256: "", created_by: "u1", created_at: "2026-10-09T10:00:00.000Z", updated_at: "2026-10-09T10:00:00.000Z", record: null, record_epoch: null, record_author: null, record_device_id: null, record_at: null, thumbnail_size: 0 }) as FileEntry;

beforeEach(() => useLocale.setState({ locale: "en" }));

describe("deleting files channels", () => {
  it("names counts, place and consequence; offers keeping objects only for unencrypted external stores", async () => {
    expect(deletionCase(info({}))).toBe("internal");
    expect(deletionCase(info({ backend: "webdav", encrypted: false }))).toBe("external_plain");
    expect(deletionCase(info({ backend: "s3", encrypted: true }))).toBe("external_encrypted");

    const { unmount } = renderWithProviders(<FilesDeletionFacts info={info({})} keep={false} onKeep={() => undefined} />);
    expect(screen.getByTestId("files-deletion-counts")).toHaveTextContent("4 files, 2 folders, 3.0 MB");
    expect(screen.getByText("Stored on this node.")).toBeInTheDocument();
    expect(screen.getByText("All files are deleted permanently.")).toBeInTheDocument();
    expect(screen.queryByTestId("files-keep-external")).toBeNull();
    unmount();

    let keep = false;
    const plain = renderWithProviders(<FilesDeletionFacts info={info({ backend: "webdav", encrypted: false, backend_host: "dav.example.com", backend_prefix: "share/" })} keep={false} onKeep={(k) => (keep = k)} />);
    expect(screen.getByText("Stored on WebDAV at dav.example.com.")).toBeInTheDocument();
    expect(screen.getByText("The objects under “share/” are deleted from the external store.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("Keep the objects on the external store"));
    expect(keep).toBe(true);
    plain.unmount();

    renderWithProviders(<FilesDeletionFacts info={info({ backend: "s3", encrypted: true, backend_host: "s3.example.com", backend_prefix: "p/" })} keep onKeep={() => undefined} />);
    expect(screen.queryByTestId("files-keep-external")).toBeNull();
    expect(screen.getByText(/unreadable without this channel's keys/)).toBeInTheDocument();
    // Keeping is never offered, so the objects are always named as deleted.
    expect(screen.getByText("The objects under “p/” are deleted from the external store.")).toBeInTheDocument();
  });
});

describe("your files of a locked channel", () => {
  beforeEach(() => useAuth.setState({ token: "t", user: me }));

  it("shows counts, sizes and dates without names and deletes the selection by ownership", async () => {
    const deleted: string[] = [];
    mockFetch({
      "/files/mine": { body: { entries: [entry("01J9ZK3G5M8Q2W4E6R8T0Y2VF1", "file", 2048), entry("01J9ZK3G5M8Q2W4E6R8T0Y2VF2", "folder", 0)], next_after: null, files: 1, folders: 1, bytes: 2048 } },
      "/files/01J9ZK3G5M8Q2W4E6R8T0Y2VF": (init) => {
        if (init.method === "DELETE") deleted.push("x");
        return { body: { files: 1, folders: 0, bytes: 2048 } };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<YourFilesPanel roomId="R1" channelId="C1" onChanged={() => undefined} />);
    expect(await screen.findByTestId("your-files-summary")).toHaveTextContent("Your files: 2 entries, 2.0 KB");
    const rows = screen.getAllByTestId("your-files-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Encrypted file");
    expect(screen.getByTestId("your-files-delete")).toBeDisabled();
    await user.click(screen.getByTestId("your-files-all"));
    await user.click(screen.getByTestId("your-files-delete"));
    expect(screen.getByTestId("your-files-confirm-text")).toHaveTextContent("Delete 2 of your entries");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleted).toHaveLength(2));
  });

  it("skips entries that are gone already (inside a deleted folder)", async () => {
    const gone = Object.assign(new Error("gone"), { status: 404 });
    let n = 0;
    expect(await deleteOwn(async () => (n++ === 0 ? undefined : Promise.reject(gone)), ["a", "b"])).toBe(1);
    await expect(deleteOwn(async () => Promise.reject(new Error("boom")), ["a"])).rejects.toThrow("boom");
  });
});

describe("the files group of the search", () => {
  it("maps index hits of files channels into their own group after the messages", () => {
    const rows = localRows([
      { conversation: "t.local/C1", id: "E1", ts: 2, author: "a@t.local", snippet: "x", files: [], room: "R1", file: { kind: "file", name: "beach.png", folder: "Trips", mime: "image/png", category: "images", size: 10, thumbnail: true, parent: "P1" } },
      { conversation: "t.local/C2", id: "M1", ts: 1, author: "a@t.local", snippet: "beach", files: [] },
    ]);
    const { messages, files } = splitRows(rows);
    expect(messages.map((r) => r.messageId)).toEqual(["M1"]);
    expect(files.map((r) => [r.messageId, r.file?.folder, r.roomId])).toEqual([["E1", "Trips", "R1"]]);
  });

  it("resolves folder paths of the sync from folder records, fetching missing parents", async () => {
    const folder = (id: string, parent: string | null) => ({ ...entry(id, "folder", 0), parent_id: parent });
    const names: Record<string, string> = { A: "Trips", B: "2026" };
    const fetched: string[] = [];
    const paths = new FolderPaths(
      async (e) => names[e.id] ?? null,
      async (id) => {
        fetched.push(id);
        return { entry: folder("B", "A"), path: [folder("A", null), folder("B", "A")] };
      },
    );
    expect(await paths.path("B")).toBe("Trips/2026");
    expect(fetched).toEqual(["B"]);
    expect(await paths.path(null)).toBe("");
    await paths.note(folder("X", "A"));
    expect(await paths.path("X")).toBe("Trips/…");
  });
});
