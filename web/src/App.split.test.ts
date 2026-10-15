// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The rarely opened pages stay out of the startup bundle: App.tsx loads them with a dynamic import only. */
describe("App routes: lazily loaded pages", () => {
  const source = readFileSync(resolve(__dirname, "App.tsx"), "utf8");
  const staticImports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  it.each(["./pages/AdminPage", "./pages/UserSettingsPage", "./pages/settings/RoomSettingsPage", "./pages/AddApplicationPage", "./pages/legal/LegalPages", "./whiteboard/WhiteboardPage"])("%s", (path) => {
    expect(staticImports).not.toContain(path);
    expect(source).toContain(`import("${path}")`);
  });
});
