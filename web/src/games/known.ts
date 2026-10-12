// SPDX-License-Identifier: Apache-2.0
/**
 * The built-in list of game activity (docs/DESKTOP.md "Game activity"): process names of well-known games on Windows
 * and Linux (Wine and Proton name the process after the Windows executable). Settings → App shows the whole list;
 * each entry can be switched off and the user adds their own. Names are compared without case and `.exe`.
 */
import type { GameEntry } from "../platform/types";

export const KNOWN_GAMES: readonly GameEntry[] = [
  { process: "cs2.exe", name: "Counter-Strike 2" },
  { process: "cs2", name: "Counter-Strike 2" },
  { process: "dota2.exe", name: "Dota 2" },
  { process: "dota2", name: "Dota 2" },
  { process: "League of Legends.exe", name: "League of Legends" },
  { process: "VALORANT-Win64-Shipping.exe", name: "VALORANT" },
  { process: "FortniteClient-Win64-Shipping.exe", name: "Fortnite" },
  { process: "r5apex.exe", name: "Apex Legends" },
  { process: "r5apex_dx12.exe", name: "Apex Legends" },
  { process: "RocketLeague.exe", name: "Rocket League" },
  { process: "Overwatch.exe", name: "Overwatch 2" },
  { process: "GTA5.exe", name: "Grand Theft Auto V" },
  { process: "eldenring.exe", name: "ELDEN RING" },
  { process: "bg3.exe", name: "Baldur's Gate 3" },
  { process: "bg3_dx11.exe", name: "Baldur's Gate 3" },
  { process: "Cyberpunk2077.exe", name: "Cyberpunk 2077" },
  { process: "witcher3.exe", name: "The Witcher 3" },
  { process: "factorio", name: "Factorio" },
  { process: "factorio.exe", name: "Factorio" },
  { process: "Terraria.exe", name: "Terraria" },
  { process: "Terraria.bin.x86_64", name: "Terraria" },
  { process: "Stardew Valley.exe", name: "Stardew Valley" },
  { process: "StardewValley", name: "Stardew Valley" },
  { process: "RimWorldWin64.exe", name: "RimWorld" },
  { process: "RimWorldLinux", name: "RimWorld" },
  { process: "Valheim.exe", name: "Valheim" },
  { process: "valheim.x86_64", name: "Valheim" },
  { process: "hl2.exe", name: "Half-Life 2" },
  { process: "Among Us.exe", name: "Among Us" },
  { process: "hollow_knight.exe", name: "Hollow Knight" },
  { process: "Hades2.exe", name: "Hades II" },
  { process: "PathOfExile.exe", name: "Path of Exile" },
  { process: "PathOfExile2.exe", name: "Path of Exile 2" },
  { process: "Warframe.x64.exe", name: "Warframe" },
  { process: "starcraft2.exe", name: "StarCraft II" },
  { process: "SC2_x64.exe", name: "StarCraft II" },
  { process: "Wow.exe", name: "World of Warcraft" },
];
