-- Autocmds are automatically loaded on the VeryLazy event
-- Default autocmds that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/autocmds.lua

vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter" }, {
  callback = function()
    vim.cmd('let &titlestring = "vim[" . expand("%:t") . "]"')
  end,
})

-- wrap and check for spell in text filetypes
local group = vim.api.nvim_create_augroup("lazyvim_wrap_spell", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
  group = group,
  pattern = { "text", "plaintex", "typst", "gitcommit", "markdown" },
  callback = function()
    if vim.g.vscode ~= 1 then
      vim.opt_local.wrap = true
      vim.opt_local.spell = true
    end
  end,
})
