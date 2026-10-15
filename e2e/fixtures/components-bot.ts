// SPDX-License-Identifier: Apache-2.0
/**
 * A raid planner with message components (tavrn-protocol/APPLICATIONS.md §5.10) for tests/components.spec.ts, on the
 * installed @tavrn/bot: a message that mentions it with "raid" gets the card (buttons, a select, a link button);
 * "Sign up" answers ephemerally, the class select updates the card, "Note" opens a modal whose submit is answered
 * with a stored reply. Configured like fixtures/echo-bot.ts (TAVRN_BOT_NODE, TAVRN_BOT_TOKEN, TAVRN_BOT_KEY_FILE,
 * TAVRN_BOT_STATE_DIR).
 */
import { button, createBot, modal, row, select, textInput, withComponents } from "@tavrn/bot";

function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim() || fallback;
  if (!v) {
    console.error(`${name} is not set (see e2e/tests/bot-helpers.ts)`);
    process.exit(2);
  }
  return v;
}

const bot = createBot({
  node: env("TAVRN_BOT_NODE"),
  token: env("TAVRN_BOT_TOKEN"),
  key: process.env.TAVRN_BOT_KEY ?? null,
  keyFile: process.env.TAVRN_BOT_KEY_FILE ?? null,
  stateDir: env("TAVRN_BOT_STATE_DIR", ".tavrn-state"),
  joinPolicy: "eager",
});

const classes = [
  { label: "Tank", value: "tank", emoji: "🛡️", description: "Holds the line in front" },
  { label: "Healer", value: "healer", description: "Keeps everyone alive" },
  { label: "Damage", value: "dps" },
];

/** The raid card; `chosen` is the class picked last. Long labels show the client's truncation on phones. */
function card(chosen?: string) {
  return withComponents(
    chosen ? `Raid on Friday 20:00 — class: ${chosen}` : "Raid on Friday 20:00",
    row(
      button({ label: "Sign up", customId: "raid:signup", style: "success", emoji: "✅" }),
      button({ label: "Decline", customId: "raid:decline", style: "danger" }),
      button({ label: "Note for the raid lead with a rather long label", customId: "raid:note", style: "primary" }),
      button({ label: "Guide", url: "https://guide.example/raid" }),
      button({ label: "Closed", customId: "raid:closed", disabled: true }),
    ),
    row(select("raid:class", classes, { placeholder: "Your class" })),
  );
}

bot.on("message", async (m) => {
  if (!m.mentionsMe || m.authorKind !== "user" || !/raid/i.test(m.text)) return;
  await m.reply(card());
});

// Handlers return nothing (ComponentHandler is `void | Promise<void>`): each awaits its one answer.
bot.component("raid:signup", async (i) => {
  await i.ephemeral(`You are signed up, ${i.user.split("@")[0]}.`);
});
bot.component("raid:decline", async (i) => {
  await i.error("Declining is not possible any more.");
});
bot.component("raid:class", async (i) => {
  await i.update(card(i.values?.[0] ?? "?"));
});
bot.component("raid:note", async (i) => {
  await i.modal(modal("raid:note-form", "A note for the raid lead", textInput("note", "Note", { style: "paragraph", maxLength: 200 })));
});
bot.modal("raid:note-form", async (i) => {
  await i.reply(`Note from ${i.user.split("@")[0]}: ${i.fields.note ?? ""}`);
});

bot.on("error", (e) => bot.logger.error("bot error", { error: e }));

const shutdown = async () => {
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await bot.start();
console.log(`ready ${bot.info.address}`);
