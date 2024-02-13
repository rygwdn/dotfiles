-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

vim.opt.title = true
vim.opt.diffopt = { "filler", "iwhite" } -- ignore all whitespace and sync

-- always use OSC 52 with tmux
if os.getenv("TMUX") then
  -- local clipboard_module = (vim.fn.has("nvim-0.10") and "vim.ui.clipboard.osc52" or "osc52")
  local clipboard_module = "osc52"
  vim.g.clipboard = {
    name = "Local OSC52",
    copy = {
      ["+"] = require(clipboard_module).copy("+"),
      ["*"] = require(clipboard_module).copy("*"),
    },
    paste = {
      ["+"] = require(clipboard_module).paste("+"),
      ["*"] = require(clipboard_module).paste("*"),
    },
  }
elseif vim.fn.executable("pbcopy") == 1 then
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
