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
import { apiFor, connectNode, isHome } from "../../stores/nodes";
import { useToasts } from "../../stores/toasts";
import { voiceErrorMessage } from "../errors";
import { joinVoice, leaveVoice } from "../index";
import { useVoicePresence } from "../presence";
import { useVoice, type VoiceTarget } from "../store";
import { callKey, onEnd, onRing, onUpdate, useCalls } from "./state";

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
  useCalls.getState().set((s) => onUpdate(s, domain, call, me()));
  presence(domain, call);
}

export function onRingEvent(socketDomain: string, d: { conversation_id: string; node?: string; from: string; started_at: string; group?: boolean }): void {
  const domain = d.node || socketDomain;
  const key = callKey(domain, d.conversation_id);
  const declined = !!useCalls.getState().declined[key];
  const before = useCalls.getState().ringing[key];
  useCalls.getState().set((s) =>
    onRing(s, { domain, conversationId: d.conversation_id, from: d.from, startedAt: d.started_at, group: !!d.group, receivedAt: Date.now() }, { inCall: inCall(domain, d.conversation_id), now: Date.now(), declined }),
  );
  // A new ring (not the same call announced again by another node) goes into the notification center.
  if (!before && useCalls.getState().ringing[key]) {
    const name = d.from.split("@")[0] ?? d.from;
    useNotifications.getState().push({ kind: "call", title: t("calls.incoming_from", { name }), body: d.group ? t("calls.notify_group") : d.from, path: conversationPath(domain, d.conversation_id) });
  }
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
