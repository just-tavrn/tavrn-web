// SPDX-License-Identifier: Apache-2.0
// The HTML fragment serialisation of engines from before the 2025 change to the HTML standard: attribute values escape
// only `&`, U+00A0 and `"`, so `<` and `>` stay raw inside them. Current Chromium, Firefox and jsdom (31 and later)
// escape `<` and `>` there too; older WebViews (the Tauri shell on older macOS and Windows) still serialise them raw.
// Tests that must hold on both install this serialiser for `Element.prototype.innerHTML` (reading only; parsing is the
// engine's own) and run once with each.

const VOID = new Set(["area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (s: string) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/"/g, "&quot;");

function serializeChildren(parent: Node): string {
  const children = parent instanceof HTMLTemplateElement ? parent.content.childNodes : parent.childNodes;
  let out = "";
  for (const child of children) out += serializeNode(child, parent);
  return out;
}

function serializeNode(node: Node, parent: Node): string {
  if (node instanceof Element) {
    const name = node.localName;
    const attributes = [...node.attributes].map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`).join("");
    if (VOID.has(name)) return `<${name}${attributes}>`;
    return `<${name}${attributes}>${serializeChildren(node)}</${name}>`;
  }
  if (node instanceof Text) return parent instanceof Element && RAW_TEXT.has(parent.localName) ? node.data : escapeText(node.data);
  if (node instanceof Comment) return `<!--${node.data}-->`;
  return "";
}

/** Makes `innerHTML` read like a pre-2025 engine (raw `<`/`>` in attribute values); returns the function that undoes it. */
export function useLegacyAttributeSerialization(): () => void {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (!original?.get || !original.set) throw new Error("Element.prototype.innerHTML is not an accessor in this engine");
  Object.defineProperty(Element.prototype, "innerHTML", {
    configurable: true,
    enumerable: original.enumerable,
    get(this: Element) {
      return serializeChildren(this);
    },
    set: original.set,
  });
  return () => Object.defineProperty(Element.prototype, "innerHTML", original);
}
