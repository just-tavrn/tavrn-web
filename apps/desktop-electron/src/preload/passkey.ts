// SPDX-License-Identifier: Apache-2.0
/**
 * The preload of the passkey dialog (`src/main/passkey_dialog.ts`, `passkey_window.ts`): it renders the content the main
 * process composed (the page runs no script of its own) and answers the PIN, the chosen passkey or a cancel. The PIN
 * field is cleared once its value is sent. Escape cancels. Nothing is exposed to the page.
 */
import { ipcRenderer } from "electron";
import type { DialogContent } from "../main/passkey_dialog.ts";

const DIALOG_CONTENT = "tavrn-passkey:content";
const DIALOG_STATE = "tavrn-passkey:state";
const DIALOG_ANSWER = "tavrn-passkey:answer";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

const send = (answer: unknown) => ipcRenderer.send(DIALOG_ANSWER, answer);

function render(content: DialogContent): void {
  const root = document.getElementById("passkey");
  if (!root) return;
  document.title = content.title;
  root.replaceChildren();
  root.setAttribute("aria-labelledby", "passkey-title");
  root.append(el("h1", { id: "passkey-title", textContent: content.title }));
  if (content.message) {
    const message = el("p", { id: "passkey-message", textContent: content.message });
    message.setAttribute("aria-live", "polite");
    root.append(message);
  }
  if (content.alert) {
    const alert = el("p", { className: "alert", textContent: content.alert });
    alert.setAttribute("role", "alert");
    alert.dataset.testid = "passkey-alert";
    root.append(alert);
  }
  let focus: HTMLElement | null = null;
  const cancel = el("button", { type: "button", textContent: content.cancel });
  cancel.dataset.action = content.final ? "close" : "cancel";
  cancel.addEventListener("click", () => send({ type: "cancel" }));
  if (content.pin) {
    const input = el("input", { type: "password", id: "passkey-pin", name: "pin", autocomplete: "off", required: true, minLength: 4, maxLength: 63 });
    input.spellcheck = false;
    if (content.alert) input.setAttribute("aria-invalid", "true");
    const form = el(
      "form",
      { noValidate: true },
      el("label", { htmlFor: "passkey-pin", textContent: content.pin.label }),
      input,
      // Cancel next to Continue, Continue last (the primary action at the end of the row).
      el("div", { className: "actions" }, cancel, el("button", { type: "submit", className: "primary", textContent: content.pin.submit })),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const pin = input.value;
      input.value = "";
      send({ type: "pin", pin });
    });
    root.append(form);
    focus = input;
  }
  if (content.accounts.length) {
    const list = el("ul", {});
    list.setAttribute("aria-labelledby", "passkey-message");
    content.accounts.forEach((label, index) => {
      const button = el("button", { type: "button", className: "account", textContent: label });
      button.dataset.account = String(index);
      button.addEventListener("click", () => send({ type: "account", index }));
      list.append(el("li", {}, button));
    });
    root.append(list);
    focus ??= list.querySelector("button");
  }
  if (!content.pin) root.append(el("div", { className: "actions" }, cancel));
  (focus ?? cancel).focus();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    send({ type: "cancel" });
  }
});

ipcRenderer.on(DIALOG_STATE, (_event, content: DialogContent) => render(content));

window.addEventListener("DOMContentLoaded", () => {
  void ipcRenderer.invoke(DIALOG_CONTENT).then(
    (content: DialogContent) => render(content),
    () => send({ type: "cancel" }),
  );
});
