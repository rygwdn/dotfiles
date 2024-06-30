local Util = require("lazyvim.util")

return {
  {
    "nvimdev/dashboard-nvim",
    opts = function(_, opts)
      opts.config.center = {
        { action = 'lua LazyVim.pick()()',                           desc = " Find File",       icon = " ", key = "f" },
        { action = "ene",                              desc = " New File",        icon = " ", key = "n" },
        { action = 'ene | normal "+p', desc = " New from Clipboard", icon = " ", key = "p", },
        { action = 'lua LazyVim.pick("oldfiles")()',                 desc = " Recent Files",    icon = " ", key = "r" },
        { action = 'lua LazyVim.pick("live_grep")()',                desc = " Find Text",       icon = " ", key = "g" },
        { action = 'lua LazyVim.pick.config_files()()',              desc = " Config",          icon = " ", key = "c" },
        { action = "LazyExtras",                                     desc = " Lazy Extras",     icon = " ", key = "x" },
        { action = "Lazy",                                           desc = " Lazy",            icon = "󰒲 ", key = "l" },
        { action = function() vim.api.nvim_input("<cmd>qa<cr>") end, desc = " Quit",            icon = " ", key = "q" },
      }
    end,
  },
}
