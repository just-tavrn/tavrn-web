// SPDX-License-Identifier: Apache-2.0
/**
 * The "+" dialog of the room rail: create a room, or join one with an invite link or code (design note 4.9).
 * A link of another node is joined through a federated session there.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TavrnApiError, identityOfHost, type InvitePreview } from "@tavrn/sdk";
import { api } from "../lib/api";
import { parseInviteInput, type InviteTarget } from "../lib/inviteLink";
import { useAuth } from "../stores/auth";
import { apiFor, connectNode, isHome, useNodes } from "../stores/nodes";
import { indexJoinedRoom } from "../stores/conversationIndex";
import { describeError } from "../stores/toasts";
import { useOriginDomain } from "../lib/origin";
import { useT } from "../i18n";
import { RoomIcon } from "./Avatar";
import { RoomRules } from "./RoomRules";
import { roomPath } from "./NodeScope";
import { Button, Dialog, ErrorText, Field, Input } from "./ui";
import { AddApplicationForm } from "./AddApplicationForm";
import { webOrigin } from "../platform";

export function CreateRoomDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (path: string) => void }) {
  const t = useT();
  const [tab, setTab] = useState<"create" | "join" | "app">("create");
  const tabClass = (active: boolean) => `min-h-10 flex-1 rounded-md px-2 text-sm ${active ? "bg-accent-soft text-fg-0" : "text-fg-1 hover:bg-bg-3"}`;
  return (
    <Dialog title={tab === "create" ? t("room.create.title") : tab === "join" ? t("room.join.title") : t("addapp.title")} open={open} onClose={onClose}>
      <div role="tablist" className="mb-4 flex gap-1 rounded-lg border border-line p-1">
        <button type="button" role="tab" aria-selected={tab === "create"} className={tabClass(tab === "create")} onClick={() => setTab("create")} data-testid="tab-create-room">
          {t("room.create.tab")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "join"} className={tabClass(tab === "join")} onClick={() => setTab("join")} data-testid="tab-join-invite">
          {t("room.join.tab")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "app"} className={tabClass(tab === "app")} onClick={() => setTab("app")} data-testid="tab-add-app">
          {t("addapp.tab")}
        </button>
      </div>
      {tab === "create" && <CreateForm onClose={onClose} onCreated={(id) => onCreated(roomPath(null, id))} />}
      {tab === "join" && <JoinForm onClose={onClose} onJoined={onCreated} />}
      {tab === "app" && <AddApplicationForm onOpen={onCreated} />}
    </Dialog>
  );
}

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [joinMode, setJoinMode] = useState<"invite" | "public">("invite");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const room = await api.rooms.create({ name, join_mode: joinMode });
          void indexJoinedRoom(null, room.id);
          setName("");
          onCreated(room.id);
        } catch (err) {
          setError(describeError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={t("common.name")}>
        <Input name="room_name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </Field>
      <Field label={t("room.join_mode")}>
        <select name="join_mode" value={joinMode} onChange={(e) => setJoinMode(e.target.value as "invite" | "public")} className="min-h-10 w-full rounded-md border border-line-strong bg-bg-0 px-3 text-sm">
          <option value="invite">{t("room.join_mode.invite")}</option>
          <option value="public">{t("room.join_mode.public")}</option>
        </select>
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {t("common.create")}
        </Button>
      </div>
    </form>
  );
}

/** Friendly texts for the usual refusals of an invite. */
function joinError(t: (k: string, v?: Record<string, string | number>) => string, e: unknown): string {
  if (e instanceof TavrnApiError) {
    if (e.code === "invite.invalid" || e.status === 404) return t("room.join.invalid_invite");
    if (e.code === "room.banned") return t("room.join.banned");
    if (e.code === "invite.wrong_user") return t("room.join.wrong_user");
  }
  return describeError(e);
}

function JoinForm({ onClose, onJoined }: { onClose: () => void; onJoined: (path: string) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const remoteHome = useAuth((s) => !!s.home);
  const origin = useOriginDomain();
  // A stable selection (zustand compares by reference); the map is derived below.
  const sessions = useNodes((s) => s.sessions);
  const webs = useMemo(() => Object.fromEntries(Object.values(sessions).map((x) => [x.domain, x.web ?? ""])), [sessions]);
  const [input, setInput] = useState("");
  const [target, setTarget] = useState<InviteTarget | null>(null);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** The node of a target: links of this client's origin belong to the origin node (a home of another node uses it federated). */
  const nodeOf = (tg: InviteTarget): string | null => {
    const node = tg.node ?? (remoteHome ? origin : null);
    return node && !isHome(node) ? node : null;
  };
  const check = async () => {
    setError(null);
    setPreview(null);
    let tg = parseInviteInput(input, { origin: webOrigin(), webs });
    if (!tg) {
      setError(t("room.join.not_a_link"));
      return;
    }
    setBusy(true);
    try {
      // A link on the app host of a delegated node (`app.tavrn.org` for `tavrn.org`, design note 4.2c).
      if (tg.node && !(tg.node in webs)) tg = { ...tg, node: (await identityOfHost(tg.node).catch(() => null)) ?? tg.node };
      const node = nodeOf(tg);
      if (node) await connectNode(node);
      setTarget(tg);
      setPreview(await apiFor(node).invites.preview(tg.code));
      setAccepted(false);
    } catch (e) {
      setError(joinError(t, e));
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const node = nodeOf(target);
      const room = await apiFor(node).invites.join(target.code, { accept_rules: accepted });
      void indexJoinedRoom(node, room.id);
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      setInput("");
      setPreview(null);
      onJoined(roomPath(node, room.id));
    } catch (e) {
      setError(joinError(t, e));
    } finally {
      setBusy(false);
    }
  };
  const node = target ? nodeOf(target) : null;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (preview) void join();
        else void check();
      }}
    >
      <Field label={t("room.join.link")} hint={t("room.join.link_hint")}>
        <Input
          name="invite_link"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setPreview(null);
            setError(null);
          }}
          autoComplete="off"
          placeholder="https://node.example/invite/AbC123"
        />
      </Field>
      {preview && (
        <div className="space-y-2 rounded-md border border-line bg-bg-0 p-3" data-testid="join-preview">
          <div className="flex items-center gap-3">
            <RoomIcon room={preview.room} size={40} node={node} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" data-testid="join-preview-name">
                {preview.room.name}
              </p>
              <p className="truncate text-xs text-fg-2">
                {t("invite.members", { count: preview.room.member_count })}
                {node ? ` · ${node}` : ""}
              </p>
            </div>
          </div>
          {preview.rules && (
            <>
              <RoomRules markdown={preview.rules} compact />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="h-5 w-5" /> {t("invite.accept_rules")}
              </label>
            </>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {preview ? (
          <Button type="submit" disabled={busy || (!!preview.rules && !accepted)} data-testid="join-invite-submit">
            {t("invite.join")}
          </Button>
        ) : (
          <Button type="submit" disabled={busy || !input.trim()} data-testid="join-invite-check">
            {t("room.join.check")}
          </Button>
        )}
      </div>
    </form>
  );
}
