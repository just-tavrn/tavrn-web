// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { previewing } from "../stores/rolePreview";
import { toastPreviewRefused } from "../lib/previewGuard";
import type { Attachment, Gif } from "@tavrn/sdk";
import { errorMessage, t as translate, useT } from "../i18n";
import { formatSize } from "./AttachmentView";
import { GifPicker } from "./GifPicker";
import { EmojiPicker, type CustomEmoji } from "./Reactions";
import { fuzzyFilter } from "../commands/fuzzy";
import { activeArgIndex, currentToken, parseArgs, parseCommandLine, tokenize } from "../commands/parse";
import { ArgumentHint, CommandHelp, CommandList, argLabel } from "../commands/CommandPalette";
import { choiceSuggestions, resolveCommand } from "../commands/merge";
import type { ArgValue, CommandArg, CommandDefinition } from "../commands/types";
import { UPLOAD_CATEGORIES, acceptFor, classifyFile, isAllowed, type UploadCategory } from "../lib/uploads";
import type { LinkPreview } from "../lib/linkPreview";
import { useUploadPrivacy } from "./UploadPrivacy";
import { useComposePreview } from "./ComposePreview";
import { wrapSpoiler } from "../lib/markdown";
import { renameClipboardFiles } from "../lib/clipboardName";
import { composerGrowth, PHONE_MAX_WIDTH, type Growth } from "../lib/composerGrowth";
import { blockedText, isAutomodBlock } from "../moderation/blocked";
import { EyeOffIcon } from "./icons";
import { ContextMenu, menuItem, useContextMenu, type MenuItem } from "./ContextMenu";
import type { PollKind } from "../polls/model";

export interface PendingUpload {
  key: string;
  name: string;
  size: number;
  progress: number;
  attachment?: Attachment;
  error?: string;
  /** Image metadata was removed before the upload, or could not be (design note 4.13 item 6). */
  note?: "removed" | "not_removed";
  /** Shown blurred until clicked (design note 4.13). */
  spoiler?: boolean;
}

export interface SendPayload {
  body: string;
  attachmentIds: string[];
  gif?: Gif;
  /** Link preview created while composing (design note 4.13 item 7). */
  preview?: LinkPreview;
  /** The attachments (of `attachmentIds`) marked as spoilers. */
  spoilerIds?: string[];
}

/** Slash commands of the conversation (design note 4.11): what is available and how to run it. */
export interface ComposerCommands {
  available: CommandDefinition[];
  /** Runs a command; resolves when done (the input is cleared), rejects with a shown error. */
  run: (def: CommandDefinition, values: Record<string, ArgValue>) => Promise<void>;
  /** Completions for `user` and `channel` arguments. */
  suggest?: (arg: CommandArg, partial: string) => { value: string; label: string }[];
}

/** What the user may upload here (`GET /conversations/{id}/upload-policy`). */
export interface ComposerUploadPolicy {
  allowed: string[];
  executablesAllowed: boolean;
}

const ALL_CATEGORIES = 6;

/**
 * A failed upload in the user's language: the node's problem code when it has a translation, else the error's text.
 * `upload.type_forbidden` names the refused category in its meta and reads like the local pre-check.
 */
function uploadError(e: unknown): string {
  const err = e as { problem?: { code?: string; detail?: string; meta?: { category?: unknown; executable?: unknown } }; message?: string };
  if (err.problem?.code === "upload.type_forbidden") {
    const meta = err.problem.meta ?? {};
    if (meta.executable === true) return translate("upload.executable_forbidden");
    if (typeof meta.category === "string" && UPLOAD_CATEGORIES.includes(meta.category as UploadCategory)) {
      return translate("upload.type_forbidden", { category: translate(`upload.category.${meta.category}`) });
    }
  }
  return errorMessage(err.problem?.code, err.problem?.detail || err.message || translate("composer.upload_failed"));
}

export function Composer({
  placeholder,
  disabled,
  disabledReason,
  onSend,
  onTyping,
  canAttach = false,
  uploadLimitBytes,
  onUpload,
  gifsEnabled = false,
  customEmojis = [],
  commands,
  uploadPolicy,
  resolveUploadPolicy,
  above,
  encrypted = false,
  onPoll,
}: {
  placeholder: string;
  disabled?: boolean;
  disabledReason?: string;
  onSend: (payload: SendPayload) => Promise<void> | void;
  onTyping?: () => void;
  canAttach?: boolean;
  uploadLimitBytes?: number;
  onUpload?: (file: File, onProgress: (f: number) => void) => Promise<Attachment>;
  gifsEnabled?: boolean;
  customEmojis?: CustomEmoji[];
  commands?: ComposerCommands;
  uploadPolicy?: ComposerUploadPolicy;
  /** The policy while `uploadPolicy` is still loading: a file picked meanwhile is checked once it is known. */
  resolveUploadPolicy?: () => Promise<ComposerUploadPolicy | undefined>;
  /** Shown directly above the input and part of the expanded overlay (the reply bar). */
  above?: ReactNode;
  /** End-to-end encrypted conversation: link previews while typing follow their own setting. */
  encrypted?: boolean;
  /** Polls may be created here (PROTOCOL.md §7g): the ＋ button becomes a menu with "Poll" and "Date poll". */
  onPoll?: (kind: PollKind) => void;
}) {
  const t = useT();
  const paletteId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sendWhenReady, setSendWhenReady] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [commandError, setCommandError] = useState<string | undefined>();
  /** A send refused by auto-moderation (MODERATION.md §2.2): shown here, the text stays for a correction. */
  const [blocked, setBlocked] = useState<string | undefined>();
  /** The command picked from the palette: the selection is bound to it, not to its name (APPLICATIONS.md §5.4). */
  const [picked, setPicked] = useState<CommandDefinition | null>(null);
  const lastTyping = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // ---- growth on focus (design note 4.13 item 14, lib/composerGrowth.ts)
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLTextAreaElement>(null);
  const inputRow = useRef<HTMLDivElement>(null);
  /** Height of the collapsed composer: the in-flow placeholder keeps it while the overlay is expanded. */
  const collapsedBox = useRef(0);
  const [focused, setFocused] = useState(false);
  const [shrunk, setShrunk] = useState(false);
  const [growth, setGrowth] = useState<Growth>({ expanded: false, height: null });
  const [, viewportChanged] = useReducer((x: number) => x + 1, 0);
  const blurTimer = useRef<number | undefined>(undefined);
  const uploadPrivacy = useUploadPrivacy();
  const plusMenu = useContextMenu();
  const composePreview = useComposePreview(value, !disabled && !value.startsWith("/"), encrypted);
  const uploading = uploads.some((u) => !u.attachment && !u.error);
  const ready = uploads.filter((u) => u.attachment).map((u) => u.attachment!.id);
  const spoilerIds = uploads.filter((u) => u.attachment && u.spoiler).map((u) => u.attachment!.id);

  // ---- slash commands
  const line = commands ? parseCommandLine(value) : null;
  const typingName = !!line && !line.complete && dismissed !== value;
  const matches = useMemo(() => (commands && line && !line.complete ? fuzzyFilter(commands.available, line.name, (d) => d.name) : []), [commands, line?.name, line?.complete]);
  const resolved = commands && line?.complete ? resolveCommand(commands.available, line.name, picked) : null;
  const def = resolved && "def" in resolved ? resolved.def : undefined;
  const active = def && line ? activeArgIndex(def, line.rest, true) : -1;
  const activeArg = def && active >= 0 ? def.args[active] : undefined;
  const partial = line ? currentToken(line.rest) : "";
  const suggestions = useMemo(() => {
    if (!activeArg || !line || activeArg.rest || !def) return [];
    // Every argument is filled: nothing to suggest (Enter sends).
    const typed = tokenize(line.rest);
    if (typed.trailingSpace && typed.tokens.length >= def.args.length) return [];
    // Pick lists (`options`) and booleans, also before anything is typed.
    if (activeArg.options?.length || activeArg.type === "boolean") return choiceSuggestions(activeArg, partial).filter((x) => x.value !== partial).slice(0, 25);
    return commands?.suggest && (activeArg.type === "user" || activeArg.type === "channel") && partial
      ? commands.suggest(activeArg, partial).filter((x) => x.value !== partial).slice(0, 8)
      : [];
  }, [commands, def, activeArg, partial, line?.rest]);
  const paletteOpen = typingName && !!commands;
  const listLength = paletteOpen ? matches.length : suggestions.length;
  useEffect(() => setSelected(0), [line?.name, line?.complete, partial]);

  const pickCommand = (d: CommandDefinition) => {
    setPicked(d);
    const next = `/${d.name}${d.args.length ? " " : ""}`;
    setValue(next);
    // A picked command without arguments closes the list: Enter runs exactly this one.
    if (!d.args.length) setDismissed(next);
    setCommandError(undefined);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const pickSuggestion = (v: string) => {
    if (!line || !def) return;
    const rest = line.rest;
    const base = partial ? rest.slice(0, rest.length - partial.length) : rest;
    setValue(`/${def.name} ${base}${v} `.replace(/\s+$/, " "));
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const runCommand = async (): Promise<boolean> => {
    if (!commands || !line) return false;
    const r = resolveCommand(commands.available, line.name, picked);
    if (r && "ambiguous" in r) {
      setCommandError(t("cmd.error.ambiguous", { names: r.ambiguous.map((d) => d.qualifier ?? d.application?.name ?? "").join(", ") }));
      return true;
    }
    if (!r) return false;
    return runDefinition(r.def, line.rest);
  };

  const runDefinition = async (d: CommandDefinition, rest: string): Promise<boolean> => {
    if (!commands) return false;
    const parsed = parseArgs(d, rest);
    if (parsed.invalid) {
      setCommandError(t(`cmd.error.${parsed.invalid.reason}`, { arg: argLabel(parsed.invalid.arg, t) }));
      return true;
    }
    if (parsed.missing.length) {
      setCommandError(t("cmd.error.missing", { args: parsed.missing.map((a) => argLabel(a, t)).join(", ") }));
      return true;
    }
    if (d.name === "help") {
      setHelpOpen(true);
      setValue("");
      return true;
    }
    setBusy(true);
    try {
      await commands.run(d, parsed.values);
      setValue("");
      setPicked(null);
      setCommandError(undefined);
    } catch {
      // The runner reported the error; the line stays for a correction.
    } finally {
      setBusy(false);
    }
    return true;
  };

  const addFiles = async (files: FileList | File[]) => {
    if (!onUpload) return;
    for (const picked of Array.from(files)) {
      // Metadata removal and the video location warning run before the upload (and before encryption).
      const prepared = await uploadPrivacy.prepare(picked);
      if (!prepared) continue;
      const { file, note } = prepared;
      const key = `${Date.now()}-${Math.random()}`;
      if (uploadLimitBytes && file.size > uploadLimitBytes) {
        setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, error: t("composer.too_large", { limit: formatSize(uploadLimitBytes) }) }]);
        continue;
      }
      const policy = uploadPolicy ?? (await resolveUploadPolicy?.().catch(() => undefined));
      if (policy) {
        const c = await classifyFile(file);
        if (!isAllowed(c, policy.allowed, policy.executablesAllowed)) {
          const error = c.executable ? t("upload.executable_forbidden") : t("upload.type_forbidden", { category: t(`upload.category.${c.category}`) });
          setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, error }]);
          continue;
        }
      }
      setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, note }]);
      onUpload(file, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))))
        .then((attachment) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, attachment, progress: 1 } : x))))
        .catch((e: unknown) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: uploadError(e) } : x))));
    }
  };

  const submit = async (gif?: Gif) => {
    if (!gif && line && (await runCommand())) return;
    const body = value.trim();
    if (uploading) {
      setSendWhenReady(true);
      return;
    }
    if ((!body && ready.length === 0 && !gif) || busy) return;
    setBusy(true);
    setBlocked(undefined);
    try {
      await onSend({ body, attachmentIds: ready, gif, preview: gif ? undefined : (composePreview.preview ?? undefined), ...(spoilerIds.length ? { spoilerIds } : {}) });
      setValue("");
      composePreview.reset();
      setUploads([]);
      setGifOpen(false);
    } catch (e) {
      // The caller has already reported other errors; the text stays for sending again.
      if (isAutomodBlock(e)) setBlocked(blockedText(e, t));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (sendWhenReady && !uploading) {
      setSendWhenReady(false);
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendWhenReady, uploading]);

  useEffect(() => {
    window.addEventListener("resize", viewportChanged);
    return () => {
      window.removeEventListener("resize", viewportChanged);
      window.clearTimeout(blurTimer.current);
    };
  }, []);

  // Measures before paint: the text's height in a hidden twin of the textarea (measuring the textarea itself
  // would reset its height and break the transition), the rest of the composer, the viewport. It runs after every
  // render (the toolbar, chips, pickers and reply bar all change the height), but reads layout only when the
  // composer can grow: without focus or text, after Escape or on phones it stays collapsed, so a render of the
  // conversation (new messages, typing) forces no reflow here.
  useLayoutEffect(() => {
    if (!focused || shrunk || !value || window.innerWidth < PHONE_MAX_WIDTH) {
      if (growth.expanded || growth.height !== null) setGrowth({ expanded: false, height: null });
      return;
    }
    const el = textarea.current;
    const twin = mirror.current;
    const row = inputRow.current;
    if (!el || !twin || !row || !anchor.current || !panel.current) return;
    if (!growth.expanded) collapsedBox.current = anchor.current.offsetHeight;
    let contentHeight = 0;
    if (focused && value) {
      // Only on a change: assigning scrolls the twin, and popups (emoji picker) close on any scroll.
      const width = `${el.clientWidth}px`;
      if (twin.style.width !== width) twin.style.width = width;
      if (twin.value !== value) twin.value = value;
      contentHeight = twin.scrollHeight;
    }
    const next = composerGrowth({
      focused,
      dismissed: shrunk,
      contentHeight,
      collapsedHeight: twin.offsetHeight,
      // Everything but the input row's content box; independent of the textarea's (possibly animating) height.
      chromeHeight: panel.current.offsetHeight - rowContentHeight(row),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (next.expanded !== growth.expanded || next.height !== growth.height) setGrowth(next);
  });

  const insertAtCursor = (text: string) => {
    const el = textarea.current;
    if (!el) return setValue((v) => v + text);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    setValue(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  /** Wraps the selection in `||…||` (toolbar button, Ctrl+Shift+S). */
  const spoiler = () => {
    const el = textarea.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = wrapSpoiler(value, start, end);
    setValue(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.start, next.end);
    });
  };

  const restricted = uploadPolicy && uploadPolicy.allowed.length < ALL_CATEGORIES;
  const allowedText = uploadPolicy ? uploadPolicy.allowed.map((c) => t(`upload.category.${c}`)).join(", ") : "";
  const accept = uploadPolicy ? acceptFor(uploadPolicy.allowed) : "";

  return (
    <div
      ref={anchor}
      className="relative shrink-0"
      style={growth.expanded ? { height: collapsedBox.current } : undefined}
      data-testid="composer"
      data-expanded={growth.expanded || undefined}
      // React focus events bubble through portals, so the emoji picker's popup counts as inside. Blur and
      // focus of a move within the composer are separate events: the blur waits a task, or the overlay
      // would collapse and grow again in between.
      onFocus={() => {
        window.clearTimeout(blurTimer.current);
        if (!focused) setShrunk(false);
        setFocused(true);
      }}
      onBlur={() => {
        blurTimer.current = window.setTimeout(() => setFocused(false), 0);
      }}
    >
    <textarea ref={mirror} aria-hidden tabIndex={-1} readOnly rows={1} className="pointer-events-none invisible absolute left-0 top-0 min-h-10 resize-none overflow-hidden px-1 py-2.5 text-sm leading-5" />
    <div ref={panel} data-testid="composer-panel" className={growth.expanded ? "composer-overlay absolute inset-x-0 bottom-0 z-20 bg-bg-2" : undefined}>
    {above}
    <form
      className={`border-t border-line p-3 ${dragging ? "bg-accent-soft" : ""}`}
      style={{ paddingBottom: "max(0.75rem, var(--safe-bottom))" }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canAttach) return;
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {disabled && disabledReason && <p className="mb-2 text-xs text-fg-2">{disabledReason}</p>}
      {uploadPrivacy.dialog}
      {composePreview.card && <div className="mb-2">{composePreview.card}</div>}
      {gifOpen && <GifPicker onPick={(g) => void submit(g)} onClose={() => setGifOpen(false)} />}
      {helpOpen && commands && <CommandHelp items={commands.available} onClose={() => setHelpOpen(false)} />}
      {paletteOpen && <CommandList id={paletteId} items={matches} selected={selected} onPick={pickCommand} onHover={setSelected} />}
      {def && !typingName && <ArgumentHint def={def} active={active} suggestions={suggestions} selected={selected} onPick={pickSuggestion} error={commandError} />}
      {blocked && (
        <p className="mb-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert" data-testid="composer-blocked">
          {blocked}
        </p>
      )}
      {!def && !typingName && commandError && (
        <p className="mb-2 rounded-lg border border-line bg-bg-1 px-3 py-2 text-xs text-danger" role="alert" data-testid="command-error">
          {commandError}
        </p>
      )}
      {uploads.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" data-testid="pending-uploads">
          {uploads.map((u) => (
            <li key={u.key} className={`flex min-h-8 items-center gap-2 rounded-md border px-2 text-xs ${u.error ? "border-danger/50 text-danger" : "border-line text-fg-1"}`}>
              <span className="max-w-40 truncate">{u.name}</span>
              {u.note && !u.error && (
                <span className="text-fg-2" data-testid="metadata-note" title={t(`upload.metadata.note_hint.${u.note}`)}>
                  {t(`upload.metadata.note.${u.note}`)}
                </span>
              )}
              <span className="text-fg-2" data-testid={u.error ? "upload-error" : undefined}>
                {u.error ?? (u.attachment ? formatSize(u.size) : `${Math.round(u.progress * 100)} %`)}
              </span>
              {sendWhenReady && !u.attachment && !u.error && <span className="text-fg-2">{t("composer.sending_when_ready")}</span>}
              {!u.error && (
                <button
                  type="button"
                  aria-pressed={!!u.spoiler}
                  aria-label={t("composer.spoiler_file", { name: u.name })}
                  title={t("composer.spoiler_file", { name: u.name })}
                  onClick={() => setUploads((x) => x.map((y) => (y.key === u.key ? { ...y, spoiler: !y.spoiler } : y)))}
                  className={`min-h-6 rounded px-1 ${u.spoiler ? "bg-accent-soft text-fg-0" : "text-fg-2 hover:text-fg-0"}`}
                  data-testid="upload-spoiler"
                >
                  {u.spoiler ? "🙈" : "👁"}
                </button>
              )}
              <button type="button" aria-label={t("composer.remove", { name: u.name })} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} className="min-h-6 min-w-6 text-fg-2 hover:text-fg-0">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={inputRow} className="flex items-end gap-1 rounded-lg border border-line-strong bg-bg-0 px-2 py-2 focus-within:border-accent">
        {(canAttach || onPoll) && (
          <>
            {canAttach && (
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                accept={accept || undefined}
                aria-label={t("composer.pick_file")}
                data-testid="file-input"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            )}
            <button
              type="button"
              aria-label={onPoll ? t("composer.plus") : t("composer.attach")}
              aria-haspopup={onPoll ? "menu" : undefined}
              aria-expanded={onPoll ? plusMenu.open : undefined}
              title={restricted && !onPoll ? t("upload.allowed", { categories: allowedText }) : undefined}
              disabled={disabled}
              onClick={(e) => {
                if (!onPoll) return fileInput.current?.click();
                if (plusMenu.open) plusMenu.close();
                else plusMenu.openAt(e.currentTarget);
              }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0 disabled:opacity-40"
              data-testid="composer-plus"
            >
              ＋
            </button>
            {onPoll && plusMenu.open && plusMenu.anchor && (
              <ContextMenu
                entries={[
                  canAttach && menuItem("file", t("composer.attach"), () => fileInput.current?.click(), { icon: "📎", hint: restricted ? allowedText : undefined, testId: "plus-file" }),
                  menuItem("poll", t("polls.menu.poll"), () => onPoll("choice"), { icon: "📊", testId: "plus-poll" }),
                  menuItem("date", t("polls.menu.date"), () => onPoll("date"), { icon: "📅", testId: "plus-date-poll" }),
                ].filter((x): x is MenuItem => !!x)}
                anchor={plusMenu.anchor}
                onClose={plusMenu.close}
                label={t("composer.plus")}
                testId="composer-plus-menu"
              />
            )}
          </>
        )}
        <textarea
          ref={textarea}
          aria-label={t("composer.message")}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          role={commands ? "combobox" : undefined}
          aria-expanded={commands ? paletteOpen : undefined}
          aria-controls={paletteOpen ? paletteId : undefined}
          aria-activedescendant={paletteOpen && matches.length ? `${paletteId}-${selected}` : undefined}
          aria-autocomplete={commands ? "list" : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setBlocked(undefined);
            if (!e.target.value.startsWith("/")) setPicked(null);
            setCommandError(undefined);
            setShrunk(false);
            const now = Date.now();
            if (onTyping && now - lastTyping.current > 3000 && !e.target.value.startsWith("/")) {
              lastTyping.current = now;
              onTyping();
            }
          }}
          onPaste={(e) => {
            // Role preview: pasted files are refused with the preview's notice (text stays a local edit).
            if (previewing() && e.clipboardData.files.length) {
              e.preventDefault();
              toastPreviewRefused();
              return;
            }
            if (!canAttach) return;
            // A pasted screenshot carries a made-up name (image.png, {GUID}.png): named by date and time instead;
            // a file copied from a file manager keeps its name (#95).
            const files = renameClipboardFiles(Array.from(e.clipboardData.files), t("composer.pasted_image"));
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if ((paletteOpen || suggestions.length > 0) && listLength > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => (s + 1) % listLength);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => (s - 1 + listLength) % listLength);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const choice = matches[selected] ?? matches[0]!;
                // Commands without arguments run right away with Enter (Tab only completes).
                if (paletteOpen && e.key === "Enter" && choice.args.length === 0) {
                  setPicked(choice);
                  void runDefinition(choice, "");
                } else if (paletteOpen) pickCommand(choice);
                else pickSuggestion(suggestions[selected]?.value ?? suggestions[0]!.value);
                return;
              }
            }
            if (e.key === "Escape" && (paletteOpen || helpOpen)) {
              e.preventDefault();
              setDismissed(value);
              setHelpOpen(false);
              return;
            }
            if (e.key === "Escape" && growth.expanded) {
              e.preventDefault();
              setShrunk(true);
              return;
            }
            if ((e.key === "S" || e.key === "s") && e.shiftKey && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              spoiler();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          style={growth.height ? { height: growth.height } : undefined}
          className={`composer-text emoji-font ${growth.expanded ? "" : "max-h-40"} min-h-10 flex-1 resize-none bg-transparent px-1 py-2.5 text-sm leading-5 text-fg-0 outline-none placeholder:text-fg-2 disabled:opacity-50`}
        />
        {!disabled && (
          <button type="button" aria-label={t("composer.spoiler")} title={t("composer.spoiler_hint")} onClick={spoiler} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-bg-3 hover:text-fg-0" data-testid="composer-spoiler">
            <EyeOffIcon size={18} />
          </button>
        )}
        {!disabled && <EmojiPicker customEmojis={customEmojis} onPick={insertAtCursor} label={t("composer.emoji")} triggerClassName="flex h-10 w-10 shrink-0 items-center justify-center" />}
        {gifsEnabled && !disabled && (
          <button type="button" aria-label={t("composer.gif")} aria-pressed={gifOpen} onClick={() => setGifOpen((v) => !v)} className="flex h-10 shrink-0 items-center rounded-md px-2 text-xs font-semibold text-fg-2 hover:bg-bg-3 hover:text-fg-0">
            GIF
          </button>
        )}
        <button type="submit" aria-label={t("composer.send")} disabled={disabled || (!value.trim() && ready.length === 0) || busy || uploading} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-accent hover:bg-accent-soft hover:text-accent-hover disabled:opacity-40">
          ➤
        </button>
      </div>
      {canAttach && restricted && (
        <p className="mt-1 text-[11px] text-fg-2" data-testid="upload-allowed">
          {t("upload.allowed", { categories: allowedText })}
        </p>
      )}
    </form>
    </div>
    </div>
  );
}

/** Height of the input row's content box (the textarea, or the toolbar buttons when they are taller). */
function rowContentHeight(row: HTMLElement): number {
  const style = getComputedStyle(row);
  return row.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
}
