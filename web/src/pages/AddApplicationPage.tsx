// SPDX-License-Identifier: Apache-2.0
/**
 * The add link of an application and its consent screen (tavrn-protocol/APPLICATIONS.md §4.1): `/add/<id>` (an
 * application of the node this web client belongs to) and `/add/<domain>/<id>` (any node). The public document
 * comes from the application's home node (CORS-open, §1.8); the room picker lists every room on every node with
 * a session where the user may manage the room. The installation itself is a request to the room's node (§4.2).
 */
import { useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ALL_PERMISSIONS, PERMISSION_LABELS, Permission, TavrnApi, hasPermission, parsePermissions, type PermissionName, type PublicApplication, type RoomDetail } from "@tavrn/sdk";
import { CLIENT_HEADER, api, publicApi } from "../lib/api";
import { parseRoomParam } from "../lib/addLink";
import { useOriginDomain } from "../lib/origin";
import { useAuth } from "../stores/auth";
import { apiFor, connectNode, endpointsOf, homeDomain, isHome, useNodes } from "../stores/nodes";
import { describeError, toastError, useToasts } from "../stores/toasts";
import { roomPath } from "../components/NodeScope";
import { MediaAvatar } from "../components/Avatar";
import { BotBadge } from "../components/Badges";
import { Button, ErrorText } from "../components/ui";
import { usePermissionLabel } from "./settings/common";
import { useT } from "../i18n";
import { roomsQuery } from "../lib/queries";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The public document with the base URL of its node (for the avatar). */
interface LoadedDocument {
  doc: PublicApplication;
  base: string;
}

/** Fetches the public document of `id` from its home node `domain` and checks that it belongs to it. */
async function loadDocument(domain: string, id: string, origin: string | null): Promise<LoadedDocument> {
  let client: TavrnApi;
  let base = "";
  if (domain === origin) client = publicApi;
  else if (isHome(domain)) client = api;
  else {
    const endpoints = await endpointsOf(domain);
    base = endpoints.base;
    client = new TavrnApi({ baseUrl: base, clientHeader: CLIENT_HEADER });
  }
  const doc = await client.applications.publicDocument(id);
  const of = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  // A node serves only its own applications (§1.8): anything else is not shown.
  if (doc.node.toLowerCase() !== domain || doc.id.toUpperCase() !== id.toUpperCase() || of(doc.bot) !== domain || of(doc.owner) !== domain) {
    throw new Error("invalid application document");
  }
  return { doc, base };
}

/** A room the user may add applications to (or one listed disabled because of "no bots"). */
export interface RoomOption {
  /** null = the home node. */
  node: string | null;
  domain: string;
  room: RoomDetail;
  perms: bigint;
  noBots: boolean;
}

/** Rooms on every node with a session where the user holds `manage_applications` (§4.1). */
function useManageableRooms(): { options: RoomOption[]; loading: boolean } {
  const home = homeDomain() ?? "";
  const domains = useNodes((s) => Object.keys(s.sessions).filter((d) => d !== home).sort().join(","));
  const remote = domains ? domains.split(",") : [];
  const homeRooms = useQuery(roomsQuery(null));
  const remoteRooms = useQueries({ queries: remote.map((d) => roomsQuery(d)) });
  const rooms = [
    ...(homeRooms.data ?? []).map((r) => ({ node: null as string | null, domain: home, id: r.id })),
    ...remoteRooms.flatMap((q, i) => (q.data ?? []).map((r) => ({ node: remote[i]! as string | null, domain: remote[i]!, id: r.id }))),
  ];
  const details = useQueries({ queries: rooms.map((r) => ({ queryKey: ["room", r.id, r.node], queryFn: () => apiFor(r.node).rooms.get(r.id), staleTime: 30_000, retry: 1 })) });
  const options: RoomOption[] = [];
  rooms.forEach((r, i) => {
    const room = details[i]?.data;
    if (!room) return;
    const perms = room.is_owner ? ALL_PERMISSIONS : parsePermissions(room.my_permissions);
    if (!hasPermission(perms, Permission.MANAGE_APPLICATIONS)) return;
    options.push({ node: r.node, domain: r.domain, room, perms, noBots: room.no_bots });
  });
  return { options, loading: homeRooms.isPending || details.some((d) => d.isPending) };
}

export function AddApplicationPage() {
  const t = useT();
  const { domain: domainParam, id = "" } = useParams();
  const [search] = useSearchParams();
  const token = useAuth((s) => s.token);
  const origin = useOriginDomain();
  if (!token) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  const domain = domainParam ? domainParam.toLowerCase() : origin;
  return (
    <div role="main" className="flex min-h-full items-start justify-center px-4 pb-[max(1rem,var(--safe-bottom))] pt-[max(1rem,var(--safe-top))] sm:items-center">
      <div className="w-full max-w-lg rounded-xl border border-line bg-bg-1 p-4 shadow-xl sm:p-6" data-testid="add-app">
        {!ULID.test(id) ? (
          <ErrorText>{t("addapp.invalid_link")}</ErrorText>
        ) : domain ? (
          <Consent domain={domain} id={id.toUpperCase()} origin={origin} preselect={parseRoomParam(search.get("room"))} />
        ) : (
          <p className="text-sm text-fg-2">{t("addapp.loading")}</p>
        )}
      </div>
    </div>
  );
}

/** An address with its domain emphasized when it is not the room's node (design note 9d). */
function Address({ address, local, testId }: { address: string; local: string; testId: string }) {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  const foreign = domain.toLowerCase() !== local.toLowerCase();
  return (
    <span className="break-all font-mono text-xs" data-testid={testId} data-foreign={foreign || undefined}>
      {address.slice(0, at)}@<strong className={foreign ? "rounded bg-warn/15 px-0.5 text-warn" : "text-fg-1"}>{domain}</strong>
    </span>
  );
}

function Consent({ domain, id, origin, preselect }: { domain: string; id: string; origin: string | null; preselect: { node: string | null; id: string } | null }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { label } = usePermissionLabel();
  const loaded = useQuery({ queryKey: ["app-document", domain, id], queryFn: () => loadDocument(domain, id, origin), retry: false });
  const { options, loading } = useManageableRooms();
  const [choice, setChoice] = useState<string | null>(null);
  const [cleared, setCleared] = useState<bigint>(0n);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reported, setReported] = useState(false);
  const key = (o: RoomOption) => `${o.domain}/${o.room.id}`;
  const preselected = preselect ? options.find((o) => o.room.id === preselect.id && (o.node ?? null) === (isHome(preselect.node) ? null : preselect.node)) : undefined;
  const selected = options.find((o) => key(o) === choice) ?? (preselected && !preselected.noBots ? preselected : options.find((o) => !o.noBots));
  const requested = useMemo(() => (loaded.data ? parsePermissions(loaded.data.doc.requested_permissions) : 0n), [loaded.data]);
  if (loaded.isPending) return <p className="text-sm text-fg-2">{t("addapp.loading")}</p>;
  if (loaded.isError) return <ErrorText>{loaded.error instanceof Error && loaded.error.message === "invalid application document" ? t("addapp.invalid_document") : describeError(loaded.error) || t("addapp.not_found")}</ErrorText>;
  const { doc, base } = loaded.data;
  const roomDomain = selected?.domain ?? homeDomain() ?? "";
  const remote = domain !== roomDomain;
  const have = selected?.perms ?? 0n;
  const manageRoles = !!selected && (selected.room.is_owner || hasPermission(have, Permission.MANAGE_ROLES));
  const bits = PERMISSION_LABELS.filter((p) => hasPermission(requested, Permission[p.name as PermissionName]));
  const granted = bits.reduce((acc, p) => {
    const bit = Permission[p.name as PermissionName];
    return hasPermission(have, bit) && (cleared & bit) === 0n ? acc | bit : acc;
  }, 0n);
  const avatar = doc.avatar ? `${base}${doc.avatar}` : null;

  const install = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.node) await connectNode(selected.node);
      await apiFor(selected.node).applications.install(selected.room.id, { application: doc.ref, permissions: manageRoles ? granted.toString() : "0", create_role: manageRoles });
      await queryClient.invalidateQueries({ queryKey: ["installations"] });
      useToasts.getState().push({ kind: "info", title: t("addapp.installed", { name: doc.name, room: selected.room.name }) });
      navigate(roomPath(selected.node, selected.room.id, undefined, "settings/applications"));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const report = async () => {
    try {
      await api.directory.report({ subject: { kind: "application", ref: doc.ref }, check: "abuse", detail: "" });
      setReported(true);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="space-y-4" data-testid="add-app-consent">
      <div className="flex items-start gap-3">
        <MediaAvatar name={doc.name} still={avatar} size={56} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold" data-testid="add-app-name">
              {doc.name}
            </h1>
            <BotBadge />
            <span className="rounded border border-line px-1 text-[10px] text-fg-2" data-testid="add-app-visibility">
              {doc.public ? t("addapp.public") : t("addapp.private")}
            </span>
          </div>
          <p className="text-xs text-fg-2">
            {t("addapp.bot")} <Address address={doc.bot} local={roomDomain} testId="add-app-bot" />
          </p>
          <p className="text-xs text-fg-2">
            {t("addapp.owner")} <Address address={doc.owner} local={roomDomain} testId="add-app-owner" />
          </p>
        </div>
      </div>
      {doc.description && (
        <p className="whitespace-pre-wrap break-words text-sm text-fg-1" data-testid="add-app-description">
          {doc.description}
        </p>
      )}
      {remote && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg-1" data-testid="add-app-remote">
          {t("addapp.remote_home", { domain })}
        </p>
      )}

      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">{t("addapp.room")}</legend>
        {loading && options.length === 0 && <p className="text-xs text-fg-2">{t("addapp.rooms_loading")}</p>}
        {!loading && options.length === 0 && <p className="text-xs text-fg-2" data-testid="add-app-no-rooms">{t("addapp.no_rooms")}</p>}
        <ul className="max-h-56 space-y-1 overflow-y-auto" data-testid="add-app-rooms">
          {options.map((o) => {
            const k = key(o);
            const active = !!selected && key(selected) === k;
            return (
              <li key={k}>
                <label className={`flex min-h-11 items-center gap-2 rounded-md border px-2 text-sm ${active ? "border-accent bg-accent-soft" : "border-line"} ${o.noBots ? "opacity-60" : "cursor-pointer"}`} data-testid="add-app-room" data-room={o.room.id} data-disabled={o.noBots || undefined}>
                  <input type="radio" name="room" className="h-4 w-4" checked={active} disabled={o.noBots} onChange={() => setChoice(k)} />
                  <span className="min-w-0 flex-1 truncate">{o.room.name}</span>
                  <span className="shrink-0 text-[10px] text-fg-2">{o.domain}</span>
                  {o.noBots && (
                    <span className="shrink-0 text-[10px] text-danger" data-testid="add-app-room-no-bots">
                      {t("addapp.no_bots")}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {bits.length > 0 && (
        <fieldset className="space-y-1" data-testid="add-app-permissions">
          <legend className="mb-1 text-sm font-medium">{t("addapp.permissions")}</legend>
          {!manageRoles && selected && (
            <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="add-app-no-manage-roles">
              {t("addapp.everyone_only")}
            </p>
          )}
          <div className="grid gap-1 sm:grid-cols-2">
            {bits.map((p) => {
              const bit = Permission[p.name as PermissionName];
              const holds = hasPermission(have, bit);
              const enabled = holds && manageRoles;
              return (
                <label key={p.name} className={`flex min-h-9 items-center gap-2 text-sm ${enabled ? "" : "opacity-50"}`} data-testid="add-app-permission" data-permission={p.name.toLowerCase()} title={holds ? undefined : t("addapp.missing_permission")}>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    disabled={!enabled}
                    checked={enabled && (cleared & bit) === 0n}
                    onChange={(e) => setCleared((c) => (e.target.checked ? c & ~bit : c | bit))}
                  />
                  <span className="min-w-0">
                    {label(p.name as PermissionName)}
                    {!holds && <span className="block text-[10px] text-fg-2">{t("addapp.missing_permission")}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium">{t("addapp.scopes")}</p>
        <p className="text-xs text-fg-2">{t("addapp.scopes_hint")}</p>
        <ul className="flex flex-wrap gap-1" data-testid="add-app-scopes">
          {doc.scopes.map((s) => (
            <li key={s} className="rounded bg-bg-3 px-1.5 py-0.5 text-[11px]" title={t(`apps.scope.${s}`)}>
              <code>{s}</code>
            </li>
          ))}
        </ul>
      </div>
      <p className="rounded-md border border-line bg-bg-0 px-3 py-2 text-xs text-fg-1" data-testid="add-app-e2ee">
        🔒 {t("addapp.e2ee_notice")}
      </p>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <button type="button" className="min-h-10 text-left text-xs text-fg-2 underline hover:text-fg-0 disabled:no-underline" onClick={() => void report()} disabled={reported} data-testid="add-app-report">
          {reported ? t("addapp.reported") : t("addapp.report")}
        </button>
        <div className="flex gap-2">
          <Link to="/" className="flex min-h-10 items-center rounded-md px-3 text-sm text-fg-1 hover:bg-bg-3">
            {t("common.cancel")}
          </Link>
          <Button onClick={() => void install()} disabled={busy || !selected || selected.noBots} data-testid="add-app-install">
            {t("addapp.install")}
          </Button>
        </div>
      </div>
    </div>
  );
}
