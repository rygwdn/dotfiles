-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

vim.opt.title = true
vim.opt.diffopt = { "filler", "iwhite" } -- ignore all whitespace and sync

-- use pbcopy on linux servers with fake pbcopy executable
if vim.fn.executable("pbcopy") == 1 then
  vim.g.clipboard = {
    name = "pbcopy",
    copy = {
      ["+"] = { "pbcopy" },
      ["*"] = { "pbcopy" },
    },
    paste = {
      ["+"] = { "pbpaste" },
      ["*"] = { "pbpaste" },
    },
  }
end
