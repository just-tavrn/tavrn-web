// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { effectiveUploads, inheritedUpload, overrideUploadState, setOverrideUpload, type UploadSubject } from "./uploadPolicy";

// The cases of the node's uploads.rs tests (`highest_role_wins_then_overrides`, `override_layers_category_then_channel`).
const roles = [
  { id: "low", position: 1, categories: ["images", "audio", "video", "documents", "archives", "other"] },
  { id: "high", position: 5, categories: ["images"] },
  { id: "unset", position: 9, categories: null },
];

describe("effective upload categories (permissions.md \"Upload categories\")", () => {
  it("the highest role with a value wins, else @everyone; administrators get everything", () => {
    expect(effectiveUploads({ everyoneId: "e", everyone: ["documents"], roles }, [])).toEqual(["images"]);
    expect(effectiveUploads({ everyoneId: "e", everyone: ["documents"], roles: [] }, [])).toEqual(["documents"]);
    expect(effectiveUploads({ everyoneId: "e", everyone: [], roles: [], privileged: true }, [])).toHaveLength(6);
    expect(effectiveUploads({ everyoneId: "e", everyone: null, roles: [] }, [])).toHaveLength(6);
  });

  it("each layer: @everyone, then the member's roles (deny, then allow), then the member", () => {
    const overrides = [
      { subject_type: "role", subject_id: "e", upload_allow: ["video"], upload_deny: ["images"] },
      { subject_type: "role", subject_id: "high", upload_allow: ["audio"], upload_deny: [] },
      { subject_type: "role", subject_id: "other-role", upload_allow: ["other"], upload_deny: [] },
    ];
    expect(effectiveUploads({ everyoneId: "e", everyone: ["documents"], roles }, [overrides])).toEqual(["audio", "video"]);
    const member = [{ subject_type: "member", subject_id: "u", upload_allow: [], upload_deny: ["video"] }];
    expect(effectiveUploads({ everyoneId: "e", everyone: ["video", "audio"], roles: [], memberId: "u" }, [member])).toEqual(["audio"]);
    expect(effectiveUploads({ everyoneId: "e", everyone: ["video", "audio"], roles: [], memberId: "x" }, [member])).toEqual(["audio", "video"]);
  });

  it("the category's layer, then the channel's", () => {
    const category = [
      { subject_type: "role", subject_id: "e", upload_allow: [], upload_deny: ["video"] },
      { subject_type: "member", subject_id: "u", upload_allow: ["audio"], upload_deny: [] },
    ];
    const channel = [{ subject_type: "role", subject_id: "e", upload_allow: ["video"] }];
    const s: UploadSubject = { everyoneId: "e", everyone: ["images", "video"], roles: [], memberId: "u" };
    expect(effectiveUploads(s, [category])).toEqual(["images", "audio"]);
    expect(effectiveUploads(s, [category, channel])).toEqual(["images", "audio", "video"]);
  });

  it("what a neutral category inherits, and from which layer", () => {
    const s: UploadSubject = { everyoneId: "e", everyone: ["images", "documents"], roles: [{ id: "mods", position: 3, categories: null }] };
    expect(inheritedUpload(s, null, "documents")).toEqual({ allowed: true, source: "role" });
    expect(inheritedUpload(s, null, "video")).toEqual({ allowed: false, source: "role" });
    const category = [{ subject_type: "role", subject_id: "mods", upload_allow: ["video"], upload_deny: [] }];
    expect(inheritedUpload(s, category, "video")).toEqual({ allowed: true, source: "category" });
    expect(inheritedUpload(s, category, "documents")).toEqual({ allowed: true, source: "role" });
  });

  it("a neutral category inherits @everyone and the member's roles of the edited layer, never the subject's own", () => {
    const s: UploadSubject = { everyoneId: "e", everyone: ["images", "documents"], roles: [{ id: "mods", position: 3, categories: null }] };
    const layer = [
      { subject_type: "role", subject_id: "e", upload_allow: [], upload_deny: ["images"] },
      { subject_type: "role", subject_id: "mods", upload_allow: ["video"], upload_deny: ["documents"] },
    ];
    const asRole = { overrides: layer, subject: { type: "role", id: "mods" } };
    expect(inheritedUpload(s, null, "images", asRole)).toEqual({ allowed: false, source: "everyone" });
    expect(inheritedUpload(s, null, "documents", asRole)).toEqual({ allowed: true, source: "role" });
    // The channel's @everyone override comes after the category's.
    const category = [{ subject_type: "role", subject_id: "mods", upload_allow: ["images"], upload_deny: [] }];
    expect(inheritedUpload(s, category, "images", asRole)).toEqual({ allowed: false, source: "everyone" });
    // @everyone itself skips its own override.
    expect(inheritedUpload({ ...s, roles: [] }, null, "images", { overrides: layer, subject: { type: "role", id: "e" } })).toEqual({ allowed: true, source: "role" });
    // A member: their roles' overrides in the layer decide after @everyone; their own override is skipped.
    const member: UploadSubject = { ...s, memberId: "u" };
    const withOwn = [...layer, { subject_type: "member", subject_id: "u", upload_allow: ["documents"], upload_deny: ["video"] }];
    const asMember = { overrides: withOwn, subject: { type: "member", id: "u" } };
    expect(inheritedUpload(member, null, "documents", asMember)).toEqual({ allowed: false, source: "roles" });
    expect(inheritedUpload(member, null, "video", asMember)).toEqual({ allowed: true, source: "roles" });
    expect(inheritedUpload(member, null, "images", asMember)).toEqual({ allowed: false, source: "everyone" });
    // Owners and administrators keep everything.
    expect(inheritedUpload({ ...s, privileged: true }, null, "images", asRole)).toEqual({ allowed: true, source: "role" });
  });

  it("allow / neutral / deny of one category in an override", () => {
    const o = { upload_allow: ["images"], upload_deny: ["other"] };
    expect(overrideUploadState(o, "images")).toBe("allow");
    expect(overrideUploadState(o, "other")).toBe("deny");
    expect(overrideUploadState(o, "audio")).toBe("neutral");
    expect(setOverrideUpload(o, "images", "deny")).toEqual({ upload_allow: [], upload_deny: ["images", "other"] });
    expect(setOverrideUpload(o, "audio", "allow")).toEqual({ upload_allow: ["images", "audio"], upload_deny: ["other"] });
    expect(setOverrideUpload(o, "other", "neutral")).toEqual({ upload_allow: ["images"], upload_deny: [] });
  });
});
