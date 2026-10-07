// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n";

interface ShellControls {
  openNav: () => void;
  closeNav: () => void;
  toggleMembers: () => void;
  closeMembers: () => void;
}

const ShellContext = createContext<ShellControls>({ openNav: () => {}, closeNav: () => {}, toggleMembers: () => {}, closeMembers: () => {} });

export const useShell = () => useContext(ShellContext);

/**
 * Base layout in three tiers (see design note 3.2):
 * - Phone (< md): one column, navigation and members as drawers, toggles in the header.
 * - Tablet (md–xl): navigation visible on the left, members as a drawer.
 * - Desktop (≥ xl): room rail | channels | content | members.
 */
export function AppShell({ rail, sidebar, children, aside, headerExtra }: { rail?: ReactNode; sidebar?: ReactNode; children: ReactNode; aside?: ReactNode; headerExtra?: ReactNode }) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => mq.matches && setNavOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = () => mq.matches && setMembersOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const controls: ShellControls = {
    openNav: () => setNavOpen(true),
    closeNav: () => setNavOpen(false),
    toggleMembers: () => setMembersOpen((v) => !v),
    closeMembers: () => setMembersOpen(false),
  };
  const drawerOpen = navOpen || membersOpen;
  // Skip link (WCAG 2.4.1): to the message list of the open conversation, else to the main content.
  const [skipToMessages, setSkipToMessages] = useState(true);

  return (
    <ShellContext.Provider value={controls}>
      <a
        href="#main-content"
        className="skip-link"
        data-testid="skip-link"
        onFocus={() => setSkipToMessages(!!document.getElementById("messages"))}
        onClick={(e) => {
          e.preventDefault();
          setNavOpen(false);
          setMembersOpen(false);
          (document.getElementById("messages") ?? document.getElementById("main-content"))?.focus();
        }}
      >
        {skipToMessages ? t("a11y.skip_to_messages") : t("a11y.skip_to_content")}
      </a>
      <div className="relative flex h-full flex-col md:grid md:grid-cols-[312px_1fr] xl:grid-cols-[72px_240px_1fr_240px]" data-testid="app-shell" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div
          className={`fixed inset-y-0 left-0 z-40 flex w-[312px] max-w-[85vw] transform transition-transform md:static md:z-auto md:w-auto md:max-w-none md:translate-x-0 xl:contents ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
          data-testid="nav-drawer"
          data-open={navOpen}
        >
          <nav aria-label={t("shell.rooms")} className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-bg-0 py-3">
            {rail}
          </nav>
          <aside aria-label={t("shell.channels")} className="flex min-w-0 flex-1 flex-col overflow-y-auto border-r border-line bg-bg-1 md:w-[240px] xl:w-auto">
            {sidebar}
          </aside>
        </div>

        <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-2">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2 xl:hidden">
            <button type="button" data-testid="nav-toggle" aria-label={t("shell.open_nav")} aria-expanded={navOpen} onClick={() => setNavOpen((v) => !v)} className="min-h-11 min-w-11 rounded-md hover:bg-bg-3 md:hidden">
              ☰
            </button>
            <img src="/icon-64.png" width={28} height={28} alt="" aria-hidden="true" className="rounded-md md:hidden" />
            <span className="flex-1" />
            {/* Phones: the footer (with the bell) is inside the closed drawer, so the bell is up here too. */}
            {headerExtra && <span className="md:hidden">{headerExtra}</span>}
            <button type="button" aria-label={t("shell.open_members")} aria-expanded={membersOpen} onClick={() => setMembersOpen((v) => !v)} className="min-h-11 min-w-11 rounded-md hover:bg-bg-3">
              👥
            </button>
          </div>
          {children}
        </main>

        <aside
          aria-label={t("shell.members")}
          className={`fixed inset-y-0 right-0 z-40 w-[240px] max-w-[85vw] transform overflow-y-auto border-l border-line bg-bg-1 p-3 transition-transform xl:static xl:z-auto xl:translate-x-0 ${membersOpen ? "translate-x-0" : "translate-x-full"}`}
          data-testid="members-drawer"
          data-open={membersOpen}
        >
          {aside}
        </aside>

        {drawerOpen && (
          <button
            type="button"
            aria-label={t("shell.close_drawer")}
            className="fixed inset-0 z-30 bg-black/50 xl:hidden"
            onClick={() => {
              setNavOpen(false);
              setMembersOpen(false);
            }}
          />
        )}
      </div>
    </ShellContext.Provider>
  );
}
