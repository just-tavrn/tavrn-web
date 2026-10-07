// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EMBED_HOSTS, parseEmbed, parseStart } from "./embeds";

const P = "chat.example";

describe("parseEmbed", () => {
  it("recognises YouTube watch, short links, Shorts and start times", () => {
    const w = parseEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", P)!;
    expect(w).toMatchObject({ provider: "youtube", kind: "video", id: "dQw4w9WgXcQ", shape: "wide" });
    expect(w.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=90");
    expect(w.thumbnail).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(parseEmbed("https://youtu.be/dQw4w9WgXcQ?t=42", P)!.embedUrl).toContain("start=42");
    expect(parseEmbed("https://m.youtube.com/watch?v=dQw4w9WgXcQ", P)!.id).toBe("dQw4w9WgXcQ");
    const s = parseEmbed("https://youtube.com/shorts/abcdefghijk", P)!;
    expect(s).toMatchObject({ kind: "short", shape: "tall" });
    expect(parseEmbed("https://www.youtube.com/watch?v=short", P)).toBeNull();
    expect(parseEmbed("https://www.youtube.com/channel/UC123", P)).toBeNull();
    expect(parseEmbed("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", P)).toBeNull();
    expect(parseEmbed("https://www.youtube.com/watch?v=dQw4w9WgXc%22%3E", P)).toBeNull();
  });

  it("recognises Twitch channels, videos and clips with the parent host", () => {
    const c = parseEmbed("https://www.twitch.tv/SomeStreamer", P)!;
    expect(c).toMatchObject({ provider: "twitch", kind: "channel", id: "somestreamer" });
    expect(c.embedUrl).toBe("https://player.twitch.tv/?channel=somestreamer&parent=chat.example&autoplay=true");
    expect(parseEmbed("https://twitch.tv/videos/123456789", P)!.embedUrl).toBe("https://player.twitch.tv/?video=v123456789&parent=chat.example&autoplay=true");
    expect(parseEmbed("https://clips.twitch.tv/FunnyClipSlug-abc", P)!.embedUrl).toBe("https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc&parent=chat.example&autoplay=true");
    expect(parseEmbed("https://www.twitch.tv/streamer/clip/OtherSlug", P)!.kind).toBe("clip");
    expect(parseEmbed("https://www.twitch.tv/directory", P)).toBeNull();
    expect(parseEmbed("https://www.twitch.tv/streamer/about", P)).toBeNull();
  });

  it("recognises Vimeo and Spotify", () => {
    expect(parseEmbed("https://vimeo.com/76979871", P)!.embedUrl).toBe("https://player.vimeo.com/video/76979871?autoplay=1");
    expect(parseEmbed("https://vimeo.com/channels/staffpicks/76979871", P)!.id).toBe("76979871");
    expect(parseEmbed("https://player.vimeo.com/video/76979871", P)!.id).toBe("76979871");
    expect(parseEmbed("https://vimeo.com/about", P)).toBeNull();
    const t = parseEmbed("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x", P)!;
    expect(t).toMatchObject({ provider: "spotify", kind: "track", shape: "strip", embedUrl: "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC" });
    expect(parseEmbed("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", P)!.shape).toBe("panel");
    expect(parseEmbed("https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", P)!.kind).toBe("episode");
    expect(parseEmbed("https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF", P)).toBeNull();
  });

  it("refuses everything else and only ever points iframes at the allow list", () => {
    for (const bad of ["javascript:alert(1)", "not a url", "https://example.com/watch?v=dQw4w9WgXcQ", "ftp://youtube.com/watch?v=dQw4w9WgXcQ", "https://user@youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com:8443/watch?v=dQw4w9WgXcQ"]) {
      expect(parseEmbed(bad, P), bad).toBeNull();
    }
    for (const url of ["https://youtu.be/dQw4w9WgXcQ", "https://twitch.tv/x_y_z", "https://clips.twitch.tv/a", "https://vimeo.com/1", "https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC"]) {
      const host = new URL(parseEmbed(url, P)!.embedUrl).hostname;
      expect(EMBED_HOSTS as readonly string[]).toContain(host);
    }
  });

  it("encodes the parent host", () => {
    expect(parseEmbed("https://twitch.tv/streamer", "a&b")!.embedUrl).toContain("parent=a%26b");
  });
});

describe("parseStart", () => {
  it("reads seconds and h/m/s forms", () => {
    expect(parseStart("90")).toBe(90);
    expect(parseStart("1h2m3s")).toBe(3723);
    expect(parseStart("2m")).toBe(120);
    expect(parseStart("abc")).toBe(0);
    expect(parseStart(null)).toBe(0);
    expect(parseStart("99999999")).toBe(0);
    expect(parseStart("999999")).toBe(86_400);
  });
});
