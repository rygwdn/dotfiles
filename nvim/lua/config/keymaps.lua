-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua

if vim.g.vscode then
  vim.keymap.set(
    { "n", "x", "o" },
    "gc",
    "VSCodeCommentary",
    { expr = true, silent = true, describe = "Comment selection" }
  )
  vim.keymap.set({ "n" }, "gcc", "VSCodeCommentaryLine", { expr = true, silent = true, desc = "Comment line" })
end

vim.keymap.set({ "n", "v" }, "Q", "gq", { silent = true })
vim.keymap.set({ "n" }, "<leader>ww", ":e ~/Documents/notes/index.md<CR>", { silent = true, desc = "Open wiki" })
