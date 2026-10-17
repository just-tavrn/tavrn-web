// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal drafts of a room's privacy notice and legal notice (Room settings → "Privacy & legal", PROTOCOL.md §6b),
 * in English and German. They are skeletons, clearly marked as drafts: every `[[…]]` is for the room's managers to
 * complete; nothing here is legal advice (operator guide: tavrn/docs/room-legal.md).
 */

export interface TemplateFacts {
  /** The room's name. */
  room: string;
  /** Domain of the node that hosts the room. */
  node: string;
  /** The node's own privacy policy (`GET /node` `legal.pages.privacy`), null when it has none. */
  nodePrivacyUrl: string | null;
}

function german(locale: string): boolean {
  return locale.toLowerCase().split("-")[0] === "de";
}

export function privacyNoticeTemplate(locale: string, f: TemplateFacts): string {
  if (german(locale)) {
    const policy = f.nodePrivacyUrl ?? "[[Link zur Datenschutzerklärung des Node]]";
    return `> **Entwurf:** Ergänze jede Stelle in [[…]] und entferne diese Zeile vor dem Speichern. Keine Rechtsberatung.

# Datenschutzhinweise für den Raum „${f.room}“

**Verantwortlich:** [[Name oder Organisation]], [[Anschrift]], [[E-Mail-Adresse]]. [[Datenschutzbeauftragte(r) mit Kontakt, falls vorhanden]]

**Was in diesem Raum verarbeitet wird:** deine Mitgliedschaft (Adresse, Anzeigename, Beitrittsdatum, Rollen, Spitzname und Bild im Raum), die Nachrichten, Reaktionen und Dateien, die du in seinen Kanälen teilst, und deine Anwesenheit in seinen Sprachkanälen. Verschlüsselte Kanäle sind Ende-zu-Ende-verschlüsselt; der Node speichert sie nur verschlüsselt.

**Zweck und Rechtsgrundlage:** [[z. B. Betrieb der Community …]]; [[z. B. Art. 6 Abs. 1 lit. f DSGVO, berechtigtes Interesse an …]].

**Empfänger:** die Mitglieder des Raums (soweit die Kanäle es erlauben), seine Moderation und der Betreiber des Node ${f.node}. [[Weitere Empfänger, z. B. im Raum installierte Bots]]

**Der Node-Betreiber** ist für das Hosting selbst eigenständig verantwortlich und hat eine eigene Datenschutzerklärung: ${policy}. [[Vereinbarung mit dem Betreiber nach Art. 26 DSGVO, falls vorhanden]]

**Speicherdauer:** [[z. B. Nachrichten werden nach N Tagen gelöscht / solange der Raum besteht]].

**Deine Rechte:** Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15–21 DSGVO) über [[Kontakt]], und Beschwerde bei einer Datenschutz-Aufsichtsbehörde.
`;
  }
  const policy = f.nodePrivacyUrl ?? "[[link to the node's privacy policy]]";
  return `> **Draft:** complete every [[…]] and remove this line before you save. Not legal advice.

# Privacy notice of the room "${f.room}"

**Who is responsible:** [[name or organisation]], [[postal address]], [[e-mail address]]. [[Data protection officer and contact, if you have one]]

**What this room processes:** your membership (address, display name, join date, roles, room nickname and avatar), the messages, reactions and files you share in its channels, and your presence in its voice channels. Encrypted channels are end-to-end encrypted; the node stores them only as ciphertext.

**Purpose and legal basis:** [[e.g. running the community of …]]; [[e.g. Art. 6(1)(f) GDPR, our legitimate interest in …]].

**Recipients:** the room's members (as far as its channels allow), its moderators and the operator of the node ${f.node}. [[Other recipients, e.g. bots installed in the room]]

**The node operator** is a separate controller for the hosting itself, with its own privacy policy: ${policy}. [[Your arrangement with the operator under Art. 26 GDPR, if you have one]]

**How long:** [[e.g. messages are deleted after N days / as long as the room exists]].

**Your rights:** access, rectification, erasure, restriction, portability and objection (Art. 15–21 GDPR) via [[contact]], and a complaint to a data protection supervisory authority.
`;
}

export function legalNoticeTemplate(locale: string, f: TemplateFacts): string {
  if (german(locale)) {
    return `> **Entwurf:** Ergänze jede Stelle in [[…]] und entferne diese Zeile vor dem Speichern. Keine Rechtsberatung.

**Verantwortlich für den Raum „${f.room}“** (Angaben gemäß § 5 DDG)

[[Name bzw. Firma, Rechtsform, Vertretungsberechtigte]]  
[[Anschrift]]  
E-Mail: [[E-Mail-Adresse]]  
[[Weitere Angaben, wo erforderlich: Register und Registernummer, USt-IdNr., Aufsichtsbehörde]]
`;
  }
  return `> **Draft:** complete every [[…]] and remove this line before you save. Not legal advice.

**Responsible for the room "${f.room}"**

[[Name or company, legal form, representatives]]  
[[Postal address]]  
E-mail: [[e-mail address]]  
[[Further details where required: register and number, VAT ID, supervisory authority]]
`;
}
