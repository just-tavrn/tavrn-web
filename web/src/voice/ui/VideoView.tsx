// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useVoice } from "../store";
import { loadedSession } from "../index";

/** Snapshot interval of remote camera tiles, so a dropped camera freezes on its last frame. */
const SNAPSHOT_MS = 2_000;

/**
 * A participant's camera or screen video, attached through the LiveKit session. With `snapshot`, a small
 * still is kept every few seconds (cheap, no per-frame work), so that a camera whose connection dropped
 * freezes on its last frame instead of turning black (design note 4.5 item 7).
 */
export function VideoView({ identity, source, mirror = false, fit = "auto", onVideo, snapshot = false }: { identity: string; source: "camera" | "screen"; mirror?: boolean; fit?: "cover" | "contain" | "auto"; onVideo?: (el: HTMLVideoElement | null) => void; snapshot?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const still = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);
  // A portrait source (a phone camera held upright) is letterboxed instead of cropped to a thin band.
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setPortrait(el.videoHeight > el.videoWidth * 1.05);
    el.addEventListener("loadedmetadata", on);
    el.addEventListener("resize", on);
    return () => {
      el.removeEventListener("loadedmetadata", on);
      el.removeEventListener("resize", on);
    };
  }, []);
  const contain = fit === "contain" || (fit === "auto" && portrait);
  const present = useVoice((s) => (source === "camera" ? s.media[identity]?.camera : s.media[identity]?.screenVideo) ?? false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !present) return;
    setFrozen(false);
    onVideo?.(el);
    return loadedSession()?.attachVideo(identity, source, el);
  }, [identity, source, present, onVideo]);
  useEffect(() => {
    const el = ref.current;
    const canvas = still.current;
    if (!snapshot || !present || !el || !canvas) return;
    const take = () => {
      if (!el.videoWidth) return;
      canvas.width = 320;
      canvas.height = Math.round((320 * el.videoHeight) / el.videoWidth);
      canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    };
    const timer = setInterval(take, SNAPSHOT_MS);
    return () => {
      clearInterval(timer);
      take();
      setFrozen(true);
    };
  }, [snapshot, present]);
  const style = mirror ? { transform: "scaleX(-1)" } : undefined;
  return (
    <>
      <video ref={ref} autoPlay playsInline muted className={`h-full w-full bg-black ${contain ? "object-contain" : "object-cover"} ${frozen && !present ? "hidden" : ""}`} style={style} data-testid={`video-${source}`} data-fit={contain ? "contain" : "cover"} />
      {snapshot && <canvas ref={still} className={`h-full w-full ${contain ? "object-contain" : "object-cover"} ${frozen && !present ? "" : "hidden"}`} style={style} data-testid="video-frozen" />}
    </>
  );
}
