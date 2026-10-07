// SPDX-License-Identifier: Apache-2.0
/**
 * Stands in for `@excalidraw/mermaid-to-excalidraw` (aliased in vite.config.ts). Excalidraw loads it only
 * for its text-to-diagram dialog and for pasted Mermaid code; the real package pulls in Mermaid, KaTeX and
 * Cytoscape (several MB the node would have to embed) for a feature the whiteboard does not offer. Pasted
 * Mermaid code is inserted as plain text instead.
 */
export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error("Mermaid diagrams are not supported on this whiteboard");
}
