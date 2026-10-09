# Accessibility

The web client aims at **WCAG 2.2 level AA** (design note 4.14 item 4). This document records the audit, what is
checked automatically, the manual screen reader walkthrough, the known gaps and a template for the
accessibility statement that operators may need to publish.

The audit fixed problems without redesigning the app: the layout and the palette stay as they are, only the
tokens and the few styles that failed a contrast or size criterion were nudged (see "Design tokens" below).

## How it is checked

| Layer | What | Where |
|---|---|---|
| Playwright + axe-core | `@axe-core/playwright` scans the main screens with the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`, `wcag22aa` and `best-practice`. **Serious and critical WCAG violations fail the test**; moderate and minor findings and `best-practice`-only rules are logged and attached as `axe-findings` JSON. Runs on `chromium`, `mobile-android` and `tablet-chromium` as part of the normal Playwright run. | `e2e/tests/a11y.spec.ts` |
| Playwright keyboard test | First Tab shows the skip link, Enter moves to the message list; the create-channel dialog keeps Tab inside, closes with Escape and gives the focus back; the emoji picker opens from the keyboard, takes the focus and returns it; the media viewer keeps Tab inside; Tab leaves the whiteboard canvas (no trap); new messages of others are announced and the setting mutes them; `<html lang>` follows the locale. | `e2e/tests/a11y.spec.ts` |
| Vitest (static) | Every icon-only `<button>` has `aria-label`, `aria-labelledby` or `title`; every `<img>` has `alt`; every range input has a label and `aria-valuetext`; every `role="dialog"` is labelled; no `aria-label` on a plain `span`/`div`/`p` (ARIA prohibits names on generic elements); text fields, selects and text areas draw their border with `line-strong`, whose contrast against `bg-0`…`bg-3` (read from `styles.css`) is at least 3:1 (WCAG 1.4.11). | `web/src/test/a11yStatic.test.ts` |
| Vitest (behaviour) | Dialog focus trap, Escape and focus return; field hint and error association; tab arrow keys; the feed and its announcements. | `web/src/components/a11y.test.tsx`, `web/src/stores/accessibility.test.ts` |

Screens scanned (each on phone, tablet and desktop): sign-in, sign-in with an error, registration, forgot
password, invite; a text channel with messages (formatting, a reply, a code block, an image attachment, a link),
the navigation drawer (phone), the composer with the emoji picker, a message context menu, the media viewer, the
member list, a modal dialog (create channel), the search panel with results, a files channel with entries, all
room settings tabs, all user settings tabs, Discover, Home; friends with an incoming request, a direct message,
the whiteboard, a joined voice channel (fake microphone and camera) muted and unmuted, the voice bar and account
bar; the room header menu, the account menu (also a node admin's) and the settings navigation with the admin link;
every admin tab. `e2e/tests/files-e2ee.spec.ts` scans an end-to-end encrypted files channel with entries, the "Your
files" panel of a locked device (checkboxes named by kind, size and date; the delete buttons name their entry) and the
channel deletion dialog with its file facts (the keep option is a labelled checkbox).

Run it alone (with `E2E_NODE_BIN` or `E2E_NODE_IMAGE` set, README.md "End-to-end tests"): `cd e2e && npx playwright test tests/a11y.spec.ts --project chromium --project mobile-android
--project tablet-chromium --workers=2`. `A11Y_REPORT_DIR=<dir>` writes every finding as JSON,
`A11Y_REPORT_ONLY=1` turns the gate off (for a baseline).

## Audit (2026-10-06)

Counts are axe nodes summed over the three projects (about 51 scans per project before, 52 after: the whiteboard
was added to the scan and the files channel got entries). "Scans" is the number of screen scans with the
finding.

### Before

| Rule | Impact | Nodes (scans) | Where | Fix |
|---|---|---|---|---|
| `aria-required-children` | critical | 3 (3) | Files channel: the empty file list had `role="listbox"` without options | The list is a list box with options; the inner open and menu affordances are no longer nested controls (see `nested-interactive` below) |
| `color-contrast` | serious | 265 (50) | Muted text `fg-2` (`#7c8494`, 4.29:1 on the content background, 3.78:1 on inputs and hover), offline members (secondary text at 60 % opacity, 4.08:1) | `fg-2` → `#8a92a2` (≥ 4.5:1 on `bg-0`…`bg-3`), offline rows at 70 % opacity |
| `scrollable-region-focusable` | serious | 25 (23) | Code blocks in messages, the settings and admin content areas, the emoji picker section bar | Code blocks `tabindex="0"`; settings/admin content area focusable; the emoji section bar has one tab stop with arrow keys |
| `target-size` | serious | 21 (4) | Tablet: check boxes squeezed by long labels; inputs squeezed to 26 px because the tablet layout put the main content into the 312 px navigation column | Check boxes never shrink; the tablet layout keeps the navigation (rail and channels) in its column again (`AppShell`: the drawer is `display: contents` only from `xl`) |
| `aria-prohibited-attr` | serious | 12 (6) | `aria-label` on plain spans: voice flags, speaking glyph, lock icons, unread badges | `role="img"` on icon badges and counters (the label is their text alternative); loading placeholders `role="status"` |
| `link-in-text-block` | serious | 2 (2) | "Set up now" link in the security settings (color only) | Underlined links inside text (security settings, encryption banners) |
| `heading-order` | moderate | 127 (127) | Settings sections were `h3` under the page `h1`; member list `h3`/`h4` | Sections `h2`; member list `h2`/`h3`; DM members `h2` |
| `region`, `landmark-one-main` | moderate | 105 (33) | Sign-in, registration, password reset, invite and add-application pages without a `main` landmark | `role="main"` on those page containers |
| `page-has-heading-one` | moderate | 9 (9) | Sign-in and registration had no `h1` | The logo is the `h1` (alt text "tavrn") |
| `aria-allowed-role` | minor | 25 (25) | The composer's text area has `role="combobox"` (slash command palette) | Kept on purpose (see known gaps) |

Found during the fixes (screens not reached by the baseline scan) and fixed as well:

| Rule | Impact | Where | Fix |
|---|---|---|---|
| `nested-interactive` | serious | Files: each option of the file list contained an open button and a menu button | Those became pointer shortcuts (`aria-hidden` spans); keyboard: Enter opens, the context menu key or Shift+F10 opens the menu |
| `aria-required-children` | critical | An empty conversation: the feed had no articles | The feed role is set while messages exist |
| `button-name` | critical | Whiteboard: Excalidraw's menu button has an icon only | The client names it ("Canvas menu") |
| `skip-link` | moderate | The skip link pointed to `#messages` on pages without messages | It targets `#main-content` and prefers the message list when there is one |
| `color-contrast` | serious | White initials of picture-less avatars and room icons on bright hues (greens, yellows, cyans: down to 3.2:1) | `avatarBackground()`: the same hue, darker only where 40 % lightness misses 4.5:1 |

### After

| Rule | Impact | Nodes (scans) | Note |
|---|---|---|---|
| serious / critical | – | **0** | The gate fails on any |
| `aria-allowed-role` | minor | 34 (34) | Composer `textarea` with `role="combobox"`, see known gaps |
| `region` | moderate | 3 (3) | The context menu layer is rendered into `body` outside the landmarks (a popup) |
| `landmark-contentinfo-is-top-level` | moderate | 2 (2) | Inside Excalidraw (third party) |

Before: 3 critical + 325 serious + 241 moderate + 25 minor nodes. After: 0 critical + 0 serious + 5 moderate +
34 minor.

## What was built (checklist of design note 4.14 item 4)

- **Focus**: one `:focus-visible` ring (2 px accent, offset 2 px) for every control, never removed; drawers,
  menus and dialogs move the focus in and back out.
- **Skip link** "Skip to messages" / "Skip to main content", visible on focus (`.skip-link`); `main#main-content`
  and the message list `#messages` take the focus. Screen-reader-only text uses Tailwind's `sr-only`.
- **Dialogs** (`components/ui.tsx` `Dialog`, the media viewer, the profile card): `role="dialog"`,
  `aria-modal="true"`, labelled by their title, focus trap (`lib/focusTrap.ts`), Escape, focus return.
- **Menus**: context menus and the "⋯" menus (`ContextMenu`) with `role="menu"`, roving tabindex, arrow keys,
  Home/End, submenus, Shift+F10 and the context menu key; the presence menu got the same keyboard model and
  returns the focus to its button on Escape. The room header of the sidebar is one menu button inside the
  sidebar's `h2` (`aria-haspopup="menu"`, `aria-expanded`; Enter or Space opens the room menu with its first item
  focused); its accessible name is the room name, the node of a remote room and the number of open reports.
- **Icons** in the sidebar bars are SVG (2 px stroke, `currentColor`, `components/icons.tsx`) on 40 px targets;
  the voice bar's padlock sits in the signal bars and their text alternative names encryption and quality
  ("Encrypted · connection good"), so neither depends on colour.
- **Room rail folders** (`components/RoomRail.tsx`): rooms stay links in a list; a folder is a disclosure button
  (`aria-expanded`, `aria-controls` to the nested list of its rooms) named by its name, room count, mention or
  unread count and "contains the open room" (the folder colour is decoration only). ↑/↓, Home/End move through the
  rail, →/← expand, enter, leave and collapse folders, Enter/Space toggle, the context-menu key or Shift+F10 open
  the menus. Every drag-and-drop action is a menu entry too (WCAG 2.5.7). Badges and the drop indicator use
  `danger-solid` (3.2:1 on `bg-0`) and `accent` (6.97:1); targets stay 48 × 48 px. `e2e/tests/rail-folders.spec.ts`
  scans the rail with axe with a folder collapsed and expanded.
- **History restore after a key reset** (`components/HistoryRestoreBanner.tsx`, `pages/settings/HistoryRequestsTab.tsx`):
  the requester's banner is a labelled region with real buttons and a labelled message field; each request on the
  settings page is a labelled section with a definition list for the dates, the channels as a list and the identity
  check as a checkbox that enables "Approve" (no information by colour alone: partial coverage is spelled out). Warnings
  use the `warn` tokens on `warn/10`, like the other notices. `e2e/tests/history-restore.spec.ts` scans the banner and
  the page with axe.
- **Tabs**: the sign-in/registration switch is a tab list with arrow keys and a tab panel (`lib/a11y.ts`
  `tabListKeyDown`); the settings and admin sections are navigation links with `aria-current="page"`.
- **Pickers**: the emoji picker is a dialog with a menu grid (arrow keys, Escape, focus return) and one tab stop
  for its section bar; the composer is a combobox for slash commands (`aria-activedescendant`); search results
  are a list box driven from the search field.
- **Message list**: `role="feed"` with `article` rows (`aria-posinset`, `aria-setsize`, `aria-busy` while a page
  loads); new messages of others in the open conversation are announced in a polite live region ("New message
  from …"), muted with **Settings → Notifications → Screen reader** (device-local, `stores/accessibility.ts`).
- **Forms**: every control has a label; `Field` links its hint and, while shown, the form's error
  (`errorId` → `aria-describedby`, `aria-invalid`); errors are `role="alert"`.
- **Sliders** carry `aria-valuetext` with the unit (volumes, thresholds, audio progress); the microphone level is
  a `role="meter"` with a value text; the speaking bars are an image named "speaking".
- **Toasts**: `role="status"` (errors `role="alert"`) inside a polite live region.
- **Icon buttons and badges**: names on every icon-only button (translated), `role="img"` with a label on icon
  badges and unread counters, decorative avatars and icons `alt=""`/`aria-hidden`.
- **Time stamps**: `<time datetime>` with the full date and time as `title`.
- **Motion**: a global `prefers-reduced-motion` rule ends every remaining animation and transition (drawers,
  pulses, the speaking glow, the composer growth, cue indicators); the speaking ring stays static.
- **Language**: `<html lang>` follows the chosen locale (set at start and on every change).
- **Headings**: one `h1` per page (the channel or page title, the logo on sign-in), sections `h2`.
- **Date of birth and age gates** (`age.v1`): the date of birth is a native date input with a visible label, a hint
  and an error text in its accessible description (`aria-invalid` while wrong); the blocking dialog is a labelled modal
  with the focus inside; the "18+" badge has the name "Adults only"; the locked channel is a labelled section with a
  heading. `e2e/tests/age.spec.ts` runs axe (WCAG A/AA, serious and critical fail) on the registration form, the room
  settings, the invite page, the locked channel and the dialog, on the desktop and the phone project.

### Design tokens

Measured in `web/src/styles.css` (WCAG relative luminance). The client has one theme (dark); there is no light
theme to measure.

| Token | On | Ratio | Status |
|---|---|---|---|
| `fg-0` `#f3f4f6` | `bg-0`…`bg-3` | 17.2 … 12.9 | ok |
| `fg-1` `#b4bac6` | `bg-0`…`bg-3` | 9.7 … 7.3 | ok |
| `fg-2` `#7c8494` → **`#8a92a2`** | `bg-0`…`bg-3` | 5.03 … 3.78 → **6.04 … 4.54** | nudged |
| `accent` `#33aea6` | `bg-0`…`bg-3` | 6.97 … 5.24 | ok |
| `accent-text` on `accent` | | 6.28 | ok |
| white on `danger-solid` | | 5.97 | ok |
| `ok`, `warn`, `danger` | `bg-0`…`bg-3` | ≥ 5.05 | ok |
| `line` `#2f3542` (dividers, decorative) | `bg-1` | 1.43 | ok (not needed to identify anything) |
| **`line-strong`** `#737b8c` (borders of text fields, selects, text areas, the composer) | `bg-0`…`bg-3` | 4.45 … 3.34 | added (WCAG 1.4.11) |
| initials on `hsl(hue 45% 40%)` | | 3.2 … 7.6 → ≥ 4.5 | bright hues darker |

## Manual screen reader walkthrough

Script (run before a release; NVDA + Firefox or Chrome on Windows, VoiceOver + Safari on macOS/iOS, TalkBack +
Chrome on Android, Orca + Firefox on Linux):

1. **Sign in**: open `/login`. The page title, the heading "tavrn", the tab list "Sign in or register" (two
   tabs, arrow keys switch) and the fields with their labels are announced. Submit a wrong password: the error is
   announced at once and read again as the description of the user name and password fields. Complete the second
   factor step (code field labelled "6-digit code").
2. **Chat**: press Tab once: "Skip to messages, link"; Enter lands in the message feed ("Messages, feed"); arrow
   keys / the virtual cursor read article by article (author, time, text; the full date is the time's title).
   Have a second account send a message: it is announced once ("New message from …: …"). Turn the announcement
   off under Settings → Notifications → Screen reader and check it stays silent. Open a message's menu with
   Shift+F10: "Message menu, menu", arrow keys move, Escape returns to the message. Open the emoji picker from the
   composer's emoji button: focus lands on the first emoji, Escape returns to the button. Open an image: "Image
   viewer", Tab stays inside, Escape closes.
3. **Voice**: join a voice channel from the channel list (link "Voice channel …"). The controls announce their
   state ("Mute, toggle button, not pressed"); the speaking participant's tile reads "speaking"; muted
   participants read "Muted". In Settings → Voice & video the volume sliders read "100 %" and the microphone
   meter reads its level in dB.

Results: the walkthrough could not be run in this environment (headless Linux without Orca, NVDA or VoiceOver).
The automated checks cover the names, roles, states and live regions the script relies on; the walkthrough must
be run by a person before claiming conformance.

## Known gaps

- The composer's `textarea` has `role="combobox"` for the slash command palette; ARIA in HTML does not list it as
  allowed on `textarea` (axe `aria-allowed-role`, minor). Screen readers handle it well; kept on purpose.
- The whiteboard canvas (Excalidraw) is a drawing surface: its shapes are not accessible to screen readers beyond
  the text list the client shows; Excalidraw's own footer landmark is nested (moderate).
- The context menu layer is rendered outside the landmarks (moderate `region`), as popups usually are.
- Captions: not applicable (no prerecorded media in the app; live voice is not captioned).
- Voice tiles show video without audio description (live content, exempt at AA).
- No screen reader walkthrough has been run yet (see above).

## Accessibility statement (template for operators)

> **Template.** Operators that fall under the EU Web Accessibility Directive (public sector bodies) or the German
> Barrierefreiheitsstärkungsgesetz (BFSG, for certain consumer services from 28 June 2025) must publish an
> accessibility statement. Adapt the bracketed parts, check them against your deployment and your legal
> obligations, and link the statement from your legal pages. This is not legal advice.

---

**Accessibility statement for [service name] ([https://your-node.example])**

[Operator name] is committed to making [service name] accessible. This service runs tavrn [version], whose web
client is designed to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA, which corresponds to
the European standard EN 301 549 for web content.

**Conformance status.** The service is [fully / partially] compliant with WCAG 2.2 level AA. [Partially:] The
content listed below is not yet accessible.

**Non-accessible content.**
- The whiteboard is a drawing surface; drawings are not available as text beyond the written labels shown next
  to the board (WCAG 1.1.1).
- Live voice and video conversations are not captioned (WCAG 1.2.4, live content).
- [Content added by the operator, e.g. custom legal pages, room content posted by users, third-party embeds.]

**Preparation of this statement.** This statement was prepared on [date]. It is based on [a self-assessment /
an assessment by a third party] using automated tests (axe-core) on phone, tablet and desktop layouts and
[manual testing with screen readers]. It was last reviewed on [date].

**Feedback and contact.** If you notice barriers or need content in an accessible format, contact us:
[e-mail], [phone], [postal address]. We aim to respond within [two weeks].

**Enforcement procedure.** [EU public sector: name and contact of the national enforcement body, e.g. in
Germany the Schlichtungsstelle nach § 16 BGG.] [BFSG: the market surveillance authority responsible for your
federal state (Marktüberwachungsbehörde der Länder for accessibility).]
