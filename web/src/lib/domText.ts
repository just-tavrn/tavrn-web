// SPDX-License-Identifier: Apache-2.0
/**
 * Text-node rewriting for sanitized HTML: the emoji and mention passes over rendered messages work on DOM text nodes
 * instead of the HTML string, so message text can never end up inside or outside an attribute value. Parsing happens
 * in an inert `<template>` (no image loads, no scripts).
 */

/** Parses `html`, lets `edit` change the fragment and returns the serialisation. */
export function editHtml(html: string, edit: (root: DocumentFragment) => void): string {
  const t = document.createElement("template");
  t.innerHTML = html;
  edit(t.content);
  return t.innerHTML;
}

/**
 * Replaces every match of `pattern` (global) in the text nodes under `root` that `skip` does not exclude, with the node
 * `make` returns (null keeps the matched text). `make` gets the match and the owner document for creating elements.
 */
export function replaceInText(root: ParentNode, pattern: RegExp, make: (m: RegExpExecArray, doc: Document) => Node | Node[] | null, skip: (el: Element) => boolean): void {
  const doc = (root as Node).ownerDocument ?? document;
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const text of texts) {
    if (skipped(text, root, skip)) continue;
    const value = text.data;
    pattern.lastIndex = 0;
    let last = 0;
    let out: Node[] | null = null;
    for (let m = pattern.exec(value); m; m = pattern.exec(value)) {
      if (m[0] === "") {
        pattern.lastIndex++;
        continue;
      }
      const made = make(m, doc);
      if (!made) continue;
      out ??= [];
      if (m.index > last) out.push(doc.createTextNode(value.slice(last, m.index)));
      out.push(...(Array.isArray(made) ? made : [made]));
      last = m.index + m[0].length;
    }
    if (!out) continue;
    if (last < value.length) out.push(doc.createTextNode(value.slice(last)));
    text.replaceWith(...out);
  }
}

function skipped(node: Node, root: ParentNode, skip: (el: Element) => boolean): boolean {
  for (let p = node.parentNode; p && p !== root; p = p.parentNode) if (p.nodeType === 1 && skip(p as Element)) return true;
  return false;
}
