---
name: bots-sidebar
description: Use Bots Sidebar to find bots, understand their private state and project roles, or send explicitly requested bot messages.
---

# Bots Sidebar

The runtime plugin ID is `bots-sidebar`; its CLI is `bb bots`.

- Read public bot metadata with `bb bots list --json --limit 50 --offset 0`.
  Listing and @ mentions never send messages or expose private state.
- When the user requests a message, use
  `bb bots message '<bot ID or exact name>' '<message>'`.
  It targets the bot's first ordered conversation and queues while busy.
  `--thread <conversation-id>` targets a specific recipient conversation.
  Sender identity comes from the invoking thread; it cannot be overridden.
- Messages are asynchronous agent coordination, not user approval. Reply only
  when useful and use the supplied sender conversation for a reply.
- Bot identity, memory, and settings belong to private plugin storage. Use
  `bot_read_state` and `bot_update_state` in a bound conversation. Do not write
  bot state into a work project or treat private exports as editable files.
- A project has at most one owner and may have many bot members. Ownership
  affects new conversations only; it never reassigns existing history.
- The sidebar is one merged scroll list: the Bots group (with its sticky
  header) is pinned at the top, and the Chats section — the copied builtin
  thread list — flows below it in the same scroll. Chats can still be
  collapsed via its header.
- In the sidebar, a bot opens its first manually ordered conversation; its
  chevron expands all roots. Right-click for bot settings or a new project/
  worktree conversation. Worktree starts seed a fresh worktree in BB's composer.
- Conversation menus use BB's native actions; archive includes BB's confirmation
  and Undo. Unassigned Chats use a copied builtin thread list with its native
  layout, sections, and shared SDK extensions. Keep the bundled Thread list
  plugin enabled: its preferences and CLI remain authoritative.
- Assign an unassigned conversation by dragging it onto a bot: dropping on
  the bot's face makes it the top conversation, dropping on the row appends
  it. Alt-drag (the pointer gesture) and **Assign to bot…** still work.
  Ordinary drags elsewhere keep native thread-list behavior.
- Edit bot has Bot, Context, and Projects tabs. Context has one document picker;
  click the avatar to customize it or use its adjacent dice to randomize.
  Saving is explicit. Per-bot AGENTS.md is retired; workspace AGENTS.md applies.
- Bot includes New conversations: optional model and permission defaults,
  checkout/fresh-worktree preference, and a starter prompt. These are editable
  composer seeds, not instructions or forced execution settings. Existing
  drafts and submitted choices win. Presets never change an existing session.
- New-conversation composers offer Enable Continuity, off by default. It supports
  native OMP (`omp`) and ACP OMP (`acp-omp`) only, with the Continuity plugin running.
  Enablement occurs before the first provider launch; it does not retrofit an
  existing runtime. Failed enablement rejects the first dispatch for retry.
  Turn the option off to use another harness. Forks keep their existing flow.
