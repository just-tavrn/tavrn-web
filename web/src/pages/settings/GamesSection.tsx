// SPDX-License-Identifier: Apache-2.0
/**
 * Settings → App → Game activity (desktop app only; docs/DESKTOP.md "Game activity"): the opt-in switch "Show the game
 * I am playing", the whole list the app watches (the built-in entries, each can be switched off, and the user's own),
 * and the privacy rules in plain words. Device-local (`games/store.ts`).
 */
import { useState } from "react";
import { Link } from "react-router";
import { useT } from "../../i18n";
import { platform } from "../../platform";
import { KNOWN_GAMES } from "../../games/known";
import { useGames, useGameSupport, validEntry } from "../../games/store";
import { usePresence } from "../../stores/presence";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { Section } from "./common";

export function GamesSection() {
  const t = useT();
  const games = useGames();
  const supported = useGameSupport((s) => s.supported);
  const hidden = usePresence((s) => !!s.mine?.hide_activity);
  const [process, setProcess] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!platform().games) return null;
  const off = new Set(games.off.map((p) => p.toLowerCase()));
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validEntry({ process, name }) || !games.addOwn({ process, name })) {
      setError(t("desktop.games_invalid"));
      return;
    }
    setError(null);
    setProcess("");
    setName("");
  };
  const total = KNOWN_GAMES.length - KNOWN_GAMES.filter((g) => off.has(g.process.toLowerCase())).length + games.own.length;
  return (
    <Section title={t("desktop.games")}>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={games.enabled} onChange={(e) => games.setEnabled(e.target.checked)} data-testid="games-enabled" />
        <span>
          {t("desktop.games_toggle")}
          <span className="block text-xs text-fg-2">{t("desktop.games_hint")}</span>
        </span>
      </label>
      {games.enabled && supported === false && (
        <p className="text-sm text-fg-2" data-testid="games-unavailable">
          {t("desktop.games_unavailable")}
        </p>
      )}
      {games.enabled && hidden && (
        <p className="text-sm text-fg-2" data-testid="games-hidden">
          {t("desktop.games_hidden")}{" "}
          <Link to="/settings/privacy" className="text-accent underline">
            {t("user.tab.privacy")}
          </Link>
        </p>
      )}
      <details className="rounded-md border border-line px-3 py-2 text-sm" data-testid="games-list">
        <summary className="min-h-10 cursor-pointer py-2 text-fg-1">{t("desktop.games_list", { count: total })}</summary>
        <p className="mb-2 text-xs text-fg-2">{t("desktop.games_list_hint")}</p>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {KNOWN_GAMES.map((g) => (
            <li key={g.process}>
              <label className="flex min-h-8 items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={!off.has(g.process.toLowerCase())} onChange={(e) => games.setKnown(g.process, e.target.checked)} />
                <span>
                  {g.name} <span className="font-mono text-xs text-fg-2">{g.process}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <h3 className="mt-3 text-sm font-medium text-fg-0">{t("desktop.games_own")}</h3>
        {games.own.length === 0 ? (
          <p className="text-xs text-fg-2">{t("desktop.games_own_none")}</p>
        ) : (
          <ul className="space-y-1" data-testid="games-own">
            {games.own.map((g) => (
              <li key={g.process} className="flex min-h-10 items-center justify-between gap-2">
                <span>
                  {g.name} <span className="font-mono text-xs text-fg-2">{g.process}</span>
                </span>
                <Button variant="ghost" onClick={() => games.removeOwn(g.process)} aria-label={t("desktop.games_remove", { name: g.name })}>
                  {t("desktop.games_remove_short")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
          <Field label={t("desktop.games_process")} hint={t("desktop.games_process_hint")} errorId={error ? "games-error" : undefined}>
            <Input name="game-process" value={process} onChange={(e) => setProcess(e.target.value)} maxLength={64} autoCapitalize="off" spellCheck={false} placeholder="game.exe" />
          </Field>
          <Field label={t("desktop.games_name")}>
            <Input name="game-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
          </Field>
          <Button type="submit" data-testid="games-add">
            {t("desktop.games_add")}
          </Button>
        </form>
        <ErrorText id="games-error">{error}</ErrorText>
      </details>
    </Section>
  );
}
