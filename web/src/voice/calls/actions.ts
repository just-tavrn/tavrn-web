// SPDX-License-Identifier: Apache-2.0
/**
 * Call actions and WebSocket events (VOICE.md §11). The call itself runs through the voice session
 * (`session.ts`, target `{ call: true, channelId: <conversation id> }`): same LiveKit client, same end-to-end
 * encryption with the conversation's MLS group.
 */
import type { CallState, Conversation } from "@tavrn/sdk";
import { t } from "../../i18n";
import { conversationPath } from "../../components/NodeScope";
import { useAuth } from "../../stores/auth";
import { useNotifications } from "../../stores/notifications";
import { systemNotify } from "../../lib/notify";
import { apiFor, connectNode, isHome } from "../../stores/nodes";
import { useToasts } from "../../stores/toasts";
import { voiceErrorMessage } from "../errors";
import { joinVoice, leaveVoice } from "../index";
import { useVoicePresence } from "../presence";
import { useVoice, type VoiceTarget } from "../store";
import { callKey, onEnd, onRing, onUpdate, useCalls, type Ring } from "./state";
import { viaOf } from "../../components/ViaNode";

const me = () => useAuth.getState().user?.address ?? null;

export const callTarget = (domain: string, conversationId: string): VoiceTarget => ({ domain, roomId: "", channelId: conversationId, call: true });

/** This device is in (or joining) the call of the conversation. */
export function inCall(domain: string, conversationId: string): boolean {
  const t = useVoice.getState().target;
  return !!t && !!t.call && t.domain === domain && t.channelId === conversationId && useVoice.getState().status !== "idle";
}

/** Starts a call (or joins the running one); the view opens. */
export async function startCall(domain: string, conversationId: string): Promise<boolean> {
  useCalls.setState({ expanded: true });
  return joinVoice(callTarget(domain, conversationId), { canCreate: false, start: true });
}

/** Answers a ringing (or joins a running) call. */
export async function answerCall(domain: string, conversationId: string): Promise<boolean> {
  useCalls.getState().set((s) => onEnd(s, domain, conversationId, "answered"));
  useCalls.setState({ expanded: true });
  // A conversation of another node: the call runs there, with a federated session (FEDERATION.md §6.1).
  if (!isHome(domain)) await connectNode(domain).catch(() => undefined);
  return joinVoice(callTarget(domain, conversationId), { canCreate: false });
}

export async function declineCall(domain: string, conversationId: string): Promise<void> {
  useCalls.getState().decline(callKey(domain, conversationId));
  try {
    if (!isHome(domain)) await connectNode(domain);
    await apiFor(domain).calls.decline(conversationId);
  } catch (e) {
    // The call ended meanwhile: nothing to decline.
    if ((e as { code?: string }).code !== "call.not_active") useToasts.getState().push({ kind: "warning", title: voiceErrorMessage(e) });
  }
}

/** Feeds a call's participants into the voice presence (cues, tiles), keyed like a channel. */
function presence(domain: string, call: CallState) {
  useVoicePresence.getState().apply(domain, { room_id: "", channel_id: call.conversation_id, epoch: null, participants: call.active ? call.participants : [] });
}

/** Applies a call state (`call.update` or `GET …/call`). */
export function applyCall(domain: string, call: CallState): void {
  // Screen publishers (VOICE.md §4b) are their device's stream: the call's people are counted without them.
  const people = call.participants.some((p) => p.screen_of) ? { ...call, participants: call.participants.filter((p) => !p.screen_of) } : call;
  useCalls.getState().set((s) => onUpdate(s, domain, people, me()));
  presence(domain, call);
}

export function onRingEvent(socketDomain: string, d: { conversation_id: string; node?: string; from: string; started_at: string; group?: boolean; via?: string }): void {
  const domain = d.node || socketDomain;
  const key = callKey(domain, d.conversation_id);
  const declined = !!useCalls.getState().declined[key];
  const via = viaOf(d);
  const before = useCalls.getState().ringing[key];
  useCalls.getState().set((s) =>
    onRing(s, { domain, conversationId: d.conversation_id, from: d.from, startedAt: d.started_at, group: !!d.group, receivedAt: Date.now(), ...(via ? { via } : {}) }, { inCall: inCall(domain, d.conversation_id), now: Date.now(), declined }),
  );
  // A new ring (not the same call announced again by another node) goes into the notification center.
  const ring = useCalls.getState().ringing[key];
  if (!before && ring) {
    const { tag, ...entry } = ringNotice(ring);
    useNotifications.getState().push({ kind: "call", ...entry });
    // The desktop app in the background: a native notification. Browsers: the call UI shows one through the service
    // worker when the ring cannot be heard (`notify.ts`), and the node's push rings a frozen or closed tab.
    systemNotify({ ...entry, tag }, { browser: false });
  }
}

/** Title, text, route and tag (the push's `<node>|<conversation>`) of a ring's notifications. */
export function ringNotice(r: Ring): { tag: string; title: string; body: string; path: string } {
  const name = r.from.split("@")[0] || r.from;
  const caller = r.via ? `${r.from} ${t("invites.via", { node: r.via })}` : r.from;
  return { tag: callKey(r.domain, r.conversationId), title: t("calls.incoming_from", { name }), body: r.group ? t("calls.notify_group") : caller, path: conversationPath(r.domain, r.conversationId) };
}

export function onUpdateEvent(socketDomain: string, d: { conversation_id: string; node?: string; call: CallState }): void {
  applyCall(d.node || socketDomain, d.call);
}

export function onEndEvent(socketDomain: string, d: { conversation_id: string; node?: string; reason: string }): void {
  const domain = d.node || socketDomain;
  useCalls.getState().set((s) => onEnd(s, domain, d.conversation_id, d.reason));
  if (d.reason !== "answered" && d.reason !== "declined") {
    presence(domain, { conversation_id: d.conversation_id, active: false, participants: [], ringing: [], group: false } as CallState);
    if (inCall(domain, d.conversation_id)) void leaveVoice();
  }
}

/** Title of a call: the group's name or the other members' display names. */
export function callTitle(c: Pick<Conversation, "kind" | "name" | "members"> | undefined, self: string | null | undefined): string {
  if (!c) return "…";
  if (c.kind === "group" && c.name) return c.name;
  const others = c.members.filter((m) => m.address !== self);
  return others.map((m) => m.display_name || m.address.split("@")[0]).join(", ") || "…";
}
