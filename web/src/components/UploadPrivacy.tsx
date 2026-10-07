// SPDX-License-Identifier: Apache-2.0
/**
 * The composer's privacy step for picked files (design note 4.13 item 6): runs `prepareUpload` with the user's
 * "Remove image metadata" setting and asks in a dialog when needed ("remove / keep" for found metadata,
 * "upload anyway / cancel" for videos with a location).
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { prepareUpload, type PreparedUpload, type UploadQuestion } from "../lib/uploadPrivacy";
import { useContentPrivacy } from "../stores/contentPrivacy";
import { Button, Dialog } from "./ui";

interface Pending {
  name: string;
  question: UploadQuestion;
  resolve: (yes: boolean) => void;
}

export function useUploadPrivacy(): { prepare: (file: File) => Promise<PreparedUpload | null>; dialog: ReactNode } {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  // Several files are asked about one after another.
  const queue = useRef(Promise.resolve());

  const prepare = useCallback((file: File) => {
    const mode = useContentPrivacy.getState().metadata;
    const ask = (question: UploadQuestion) => {
      const answer = queue.current.then(() => new Promise<boolean>((resolve) => setPending({ name: file.name, question, resolve })));
      queue.current = answer.then(() => undefined);
      return answer;
    };
    return prepareUpload(file, mode, ask);
  }, []);

  const answer = (yes: boolean) => {
    pending?.resolve(yes);
    setPending(null);
  };
  const video = pending?.question.kind === "video_location";
  const found = pending?.question.kind === "metadata" ? pending.question.found.map((f) => t(`upload.metadata.found.${f}`)).join(", ") : "";
  const dialog = pending ? (
    <Dialog title={t(video ? "upload.location.title" : "upload.metadata.title")} open onClose={() => answer(false)}>
      <div className="space-y-3" data-testid={video ? "video-location-dialog" : "metadata-dialog"}>
        <p className="break-words text-sm text-fg-1">{video ? t("upload.location.body", { name: pending.name }) : t("upload.metadata.body", { name: pending.name, found })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => answer(false)} data-testid="upload-privacy-no">
            {t(video ? "common.cancel" : "upload.metadata.keep")}
          </Button>
          <Button onClick={() => answer(true)} data-testid="upload-privacy-yes">
            {t(video ? "upload.location.upload_anyway" : "upload.metadata.remove")}
          </Button>
        </div>
      </div>
    </Dialog>
  ) : null;
  return { prepare, dialog };
}
