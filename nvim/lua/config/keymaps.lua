-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua

if vim.g.vscode then
  vim.keymap.set({ "n", "x", "o" }, "gc", "VSCodeCommentary", { expr = true, silent = true })
  vim.keymap.set({ "n" }, "gcc", "VSCodeCommentaryLine", { expr = true, silent = true })
end

vim.keymap.set({ "n", "v" }, "Q", "gq", { silent = true })