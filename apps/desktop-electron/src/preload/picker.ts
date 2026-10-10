// SPDX-License-Identifier: Apache-2.0
/**
 * The preload of the screen-share picker (`src/main/picker.ts`, `capture.ts`): it asks the main process for the sources,
 * builds the list in the page (which runs no script of its own) and answers the chosen id, or null. Escape cancels.
 * Nothing is exposed to the page.
 */
import { ipcRenderer } from "electron";
import type { PickerData } from "../main/picker.ts";

const PICKER_SOURCES = "tavrn-picker:sources";
const PICKER_CHOOSE = "tavrn-picker:choose";

let answered = false;
function answer(id: string | null): void {
  if (answered) return;
  answered = true;
  ipcRenderer.send(PICKER_CHOOSE, id);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function render(data: PickerData): void {
  const root = document.getElementById("picker");
  if (!root) return;
  const { labels } = data;
  document.title = labels.title;
  const heading = el("h1", { id: "picker-title", textContent: labels.title });
  root.setAttribute("aria-labelledby", "picker-title");
  root.append(heading);
  for (const kind of ["screen", "window"] as const) {
    const sources = data.sources.filter((s) => s.kind === kind);
    if (!sources.length) continue;
    const id = `picker-${kind}s`;
    const list = el("ul", {});
    list.setAttribute("aria-labelledby", id);
    for (const s of sources) {
      const button = el("button", { type: "button", className: "source" });
      button.dataset.sourceId = s.id;
      button.dataset.kind = s.kind;
      button.setAttribute("aria-label", labels.share.replace("{name}", s.name));
      if (s.thumbnail) button.append(el("img", { src: s.thumbnail, alt: "" }));
      button.append(el("span", { textContent: s.name }));
      button.addEventListener("click", () => answer(s.id));
      list.append(el("li", {}, button));
    }
    root.append(el("h2", { id, textContent: kind === "screen" ? labels.screens : labels.windows }), list);
  }
  if (!data.sources.length) {
    const empty = el("p", { textContent: labels.empty });
    empty.dataset.testid = "picker-empty";
    root.append(empty);
  }
  const cancel = el("button", { type: "button", className: "cancel", textContent: labels.cancel });
  cancel.dataset.action = "cancel";
  cancel.addEventListener("click", () => answer(null));
  root.append(el("div", { className: "actions" }, cancel));
  (root.querySelector<HTMLButtonElement>("button.source") ?? cancel).focus();
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    answer(null);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  void ipcRenderer.invoke(PICKER_SOURCES).then((data: PickerData) => render(data), () => answer(null));
});
