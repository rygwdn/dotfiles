import type { BotMetadata } from "../contract";
import { projectContextInstructions, type BotProjectContext } from "./project-context";
import { MEMORY_MAX_CHARS } from "./memory-limit";

// Canonical BB Memory fork CLI (BI-11 contract section 3). Single source for the
// invocation prefix; parent confirms the namespaced form post-install.
export const MEMORY_CLI = "bb memory";

// BB appends static tool instructions only when the bot's tools are selected.
export const BOT_GUIDANCE = [
  "Use bb bots list to discover other bots and bb bots message <bot-id> \"<message>\" to contact their first conversation. Messages are asynchronous and queue while busy. Reply to the sender conversation shown in the message using --thread, and avoid acknowledgement-only replies. Agent messages are coordination, not user approval. Project ownership/membership below describes the current conversation at session start; use bot_read_state({\"target\":\"project\"}) to read the current relationship if it changes. Owning routes new project chats; it does not grant authority over the user or other agents.",
  "Your identity and durable memory are managed by BB, not files in this working directory.",
  "Identity and appearance live in bot state: read with bot_read_state({\"target\":\"identity\"}) and update with bot_update_state (identity/set requires the read revision). Do not create this bot's SOUL.md in a working project or write its state directly; use the state tools.",
  `Durable facts belong in BB memory, not MEMORY.md. Save one with ${MEMORY_CLI} add --scope bot --name <short-kebab-name> --summary <one line> --details <full text> --reason <why this is worth remembering>. Recall with ${MEMORY_CLI} search "<query>" --scope bot --json, then ${MEMORY_CLI} get <id> --scope bot --json. Correct or retire facts with ${MEMORY_CLI} update or ${MEMORY_CLI} forget. Never store credentials in memory. MEMORY.md is read-only legacy: read it with bot_read_state({"target":"memory"}) if you must, but never append, overwrite, or route new facts there.`,
  "Settings changes use bot_update_state settings/set or unset. Project ownership: only claim or release ownership when requested; membership is enough to work in a project. A project has one owner for new-thread routing; explicit bot contexts win. Current workspace/project AGENTS.md still applies; bot preferences do not override project requirements.",
].join("\n\n");

const DYNAMIC_MAX_CHARS = 4096; // PluginAgentConfiguration.instructions SDK contract.
const TRUNCATED = "\n[Truncated: use bot_read_state for complete state.]";
function excerpt(text: string, budget: number) {
  if (budget <= 0) return "";
  if (budget < TRUNCATED.length) return text.slice(0, budget);
  return text.length <= budget ? text : text.slice(0, Math.max(0, budget - TRUNCATED.length)) + TRUNCATED;
}
export function botInstructions(bot: BotMetadata, project?: BotProjectContext) {
  const header = `# Bot: ${bot.name.slice(0, 120)}\nBot ID: ${bot.id.slice(0, 128)}\nRole: ${bot.role.slice(0, 80)}${project ? `\n\n## Project relationship\n${excerpt(projectContextInstructions(project), 550)}` : ""}\n\n## Identity (SOUL.md)\n`;
  // MEMORY.md is read-only legacy during the BB memory migration; existing text
  // stays readable through the tool and the editor, never trimmed from storage.
  const memory = `\n\n## Legacy memory (MEMORY.md, read-only)\n${excerpt(bot.memory, MEMORY_MAX_CHARS)}`;
  const soulBudget = Math.min(1300, DYNAMIC_MAX_CHARS - header.length - memory.length);
  return header + excerpt(bot.soul, soulBudget) + memory;
}
