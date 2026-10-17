// SPDX-License-Identifier: Apache-2.0
/**
 * The interactive parts of a rendered message body (design note 4.11, PROTOCOL.md §7h): the body is sanitized HTML
 * (`lib/markdown.ts`), this component makes its pills and chips work. A user or bot pill opens the profile card (as a
 * click in the member list does: mini profile with "Full profile"), a role pill the role's member list; Enter or
 * Space on a focused pill does the same, Escape closes. A tavrn link navigates inside the client (react-router, no
 * page load); a modified or middle click keeps the browser's behaviour (the `href` is the client's own route). Chips
 * get their content (icon, name) through portals into the anchors. Nothing here sends message text anywhere.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useInRouterContext, useNavigate, type NavigateFunction } from "react-router";
import { ProfileCard } from "../components/ProfilePopover";
import type { AnchorRect } from "../lib/position";
import { chipTarget, LinkChip, type ChipTarget } from "./LinkChip";
import { RolePopover } from "./RolePopover";
import { useChatLinks } from "./context";

type Open = { kind: "user"; address: string; anchor: AnchorRect } | { kind: "role"; name: string; anchor: AnchorRect };

/** Whether rendered HTML has anything for {@link MessageBodyLinks} (cheap check before mounting it). */
export function hasInteractiveParts(html: string): boolean {
  // Only the markdown pass writes these attributes (the sanitizer drops every data attribute of the source).
  return html.includes("data-tavrn-link") || html.includes("data-address=") || html.includes("data-role=");
}

const PILL = ".mention[data-address], .mention[data-role]";

type Props = { containerRef: RefObject<HTMLElement | null>; html: string };

export function MessageBodyLinks(props: Props) {
  // Outside a router (previews, isolated tests) the links stay plain links.
  return useInRouterContext() ? <RoutedBodyLinks {...props} /> : <BodyLinks {...props} navigate={null} />;
}

function RoutedBodyLinks(props: Props) {
  return <BodyLinks {...props} navigate={useNavigate()} />;
}

function BodyLinks({ containerRef, html, navigate }: Props & { navigate: NavigateFunction | null }) {
  const { room, roomMembers } = useChatLinks();
  const [open, setOpen] = useState<Open | null>(null);
  const [chips, setChips] = useState<{ el: HTMLElement; target: ChipTarget }[]>([]);

  // The chips of this rendering: their fallback text (the URL) gives way to the chip.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const found: { el: HTMLElement; target: ChipTarget }[] = [];
    for (const a of el?.querySelectorAll<HTMLElement>("a.tavrn-chip") ?? []) {
      const target = chipTarget(a);
      if (!target) continue;
      a.textContent = "";
      found.push({ el: a, target });
    }
    setChips(found);
  }, [containerRef, html]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const openPill = (pill: HTMLElement) => {
      const anchor = pill.getBoundingClientRect();
      const address = pill.dataset.address;
      const role = pill.dataset.role;
      if (address) setOpen({ kind: "user", address, anchor });
      else if (role) setOpen({ kind: "role", name: role, anchor });
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const pill = target?.closest<HTMLElement>(PILL);
      if (pill && el.contains(pill)) {
        e.preventDefault();
        e.stopPropagation();
        openPill(pill);
        return;
      }
      const a = target?.closest<HTMLAnchorElement>("a[data-tavrn-link]");
      if (!a || !el.contains(a)) return;
      // Ctrl/Cmd/Shift/Alt or another button: the browser's own link behaviour (a new tab of this client).
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute("href");
      if (!navigate || !href?.startsWith("/") || href.startsWith("//")) return;
      e.preventDefault();
      navigate(href);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const pill = e.target instanceof HTMLElement ? e.target : null;
      if (!pill?.matches(PILL) || !el.contains(pill)) return;
      e.preventDefault();
      openPill(pill);
    };
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKey);
    };
  }, [containerRef, html, navigate]);

  return (
    <>
      {chips.map(({ el, target }, i) => createPortal(<LinkChip target={target} />, el, `${i}`))}
      {open?.kind === "user" && <ProfileCard address={open.address} anchor={open.anchor} onClose={() => setOpen(null)} />}
      {open?.kind === "role" && (
        <RolePopover name={open.name} roles={room?.roles ?? []} members={roomMembers} anchor={open.anchor} onClose={() => setOpen(null)} onPick={(address) => setOpen({ kind: "user", address, anchor: open.anchor })} />
      )}
    </>
  );
}
