// SPDX-License-Identifier: Apache-2.0
/**
 * "Add an application" (tavrn-protocol/APPLICATIONS.md §4.1): an add link or application reference pasted in the room
 * settings or the "+" dialog opens the consent screen (`/add/…`), with the room preselected when known.
 */
import { useMemo, useState } from "react";
import { parseAddInput, addPath } from "../lib/addLink";
import { useOriginDomain } from "../lib/origin";
import { useNodes } from "../stores/nodes";
import { useT } from "../i18n";
import { Button, ErrorText, Field, Input } from "./ui";
import { webOrigin } from "../platform";

export function AddApplicationForm({ room, onOpen }: { room?: { node: string | null; id: string }; onOpen: (path: string) => void }) {
  const t = useT();
  const origin = useOriginDomain();
  const sessions = useNodes((s) => s.sessions);
  const webs = useMemo(() => Object.fromEntries(Object.values(sessions).map((x) => [x.domain, x.web ?? ""])), [sessions]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    const target = parseAddInput(input, { origin: webOrigin(), webs, ownDomain: origin });
    if (!target) {
      setError(t("addapp.not_a_link"));
      return;
    }
    onOpen(addPath(target, room));
  };
  return (
    <form
      className="space-y-3"
      data-testid="add-app-form"
      onSubmit={(e) => {
        e.preventDefault();
        open();
      }}
    >
      <Field label={t("addapp.link")} hint={t("addapp.link_hint")}>
        <Input
          name="add_link"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          placeholder="https://node.example/add/01J…"
          data-testid="add-app-link"
        />
      </Field>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end">
        <Button type="submit" disabled={!input.trim()} data-testid="add-app-open">
          {t("addapp.open")}
        </Button>
      </div>
    </form>
  );
}
