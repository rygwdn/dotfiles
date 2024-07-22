-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua

-- if vim.g.vscode then
--   vim.keymap.set(
--     { "n", "x", "o" },
--     "gc",
--     "VSCodeCommentary",
--     { expr = true, silent = true, desc = "Comment selection" }
--   )
--   vim.keymap.set({ "n" }, "gcc", "VSCodeCommentaryLine", { expr = true, silent = true, desc = "Comment line" })
-- end

vim.keymap.set({ "n", "v" }, "Q", "gq", { silent = true })

vim.api.nvim_create_user_command("PasteSong", "%!pbpaste -pboard general -Prefer public.rtf | textutil -stdin -convert txt -stdout", { nargs = 0 })

vim.api.nvim_create_user_command("CopySong", function()
  vim.cmd("%s/^./\\U\\0")
  vim.cmd("%yank +")
end, { nargs = 0 })
