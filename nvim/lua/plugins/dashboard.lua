local Util = require("lazyvim.util")

return {
  {
    "nvimdev/dashboard-nvim",
    opts = function(_, opts)
      opts.config.center = {
        -- {
        --   action = "e ~/Documents/notes/index.md",
        --   desc = " Wiki Index",
        --   icon = "󱓧 ",
        --   key = "w",
        -- },
        -- {
        --   action = [[lua require('telescope.builtin').live_grep({ prompt_title = 'Find Wiki', cwd = '~/Documents/notes/' })]],
        --   desc = " Wiki Search",
        --   icon = "󰺄 ",
        --   key = "s",
        -- },
        -- TODO: replace..
        {
          action = Util.telescope("files"),
          desc = " Find file",
          icon = " ",
          key = "f",
        },
        {
          action = "ene",
          desc = " New file",
          icon = " ",
          key = "n",
        },
        {
          action = 'ene | normal "+p',
          desc = " New from Clipboard",
          icon = " ",
          key = "p",
        },
        {
          action = "Telescope oldfiles",
          desc = " Recent files",
          icon = " ",
          key = "r",
        },
        {
          action = "Telescope live_grep",
          desc = " Find text",
          icon = " ",
          key = "g",
        },
        {
          action = [[lua require("lazyvim.util").telescope.config_files()()]],
          desc = " Config",
          icon = " ",
          key = "c",
        },
        {
          action = "Lazy",
          desc = " Lazy",
          icon = "󰒲 ",
          key = "l",
        },
        {
          action = "qa",
          desc = " Quit",
          icon = " ",
          key = "q",
        },
      }
    end,
  },
}
