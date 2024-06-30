return {
  { "echasnovski/mini.pairs", enabled = false },
  {
    "windwp/nvim-autopairs",
    event = "InsertEnter",
    config = true,
    opts = {
      disable_in_visualblock = true,
    },
  },

  {
    "stevearc/conform.nvim",
    opts = {
      formatters_by_ft = {
        javascript = { { "prettierd", "prettier" } },
        typescript = { { "prettierd", "prettier" } },
      }
    }
  },

  {
    "tpope/vim-eunuch",
    vscode = true,
    cmd = {
      "Remove",
      "Delete",
      "Move",
      "Chmod",
      "Mkdir",
      "Cfind",
      "Clocate",
      "Lfind",
      "Llocalte",
      "Wall",
      "SudoWrite",
      "SudoEdit",
    },
  },
  {
    "tpope/vim-fugitive",
    cmd = {
      "Git",
      "Gedit",
      "Gsplit",
      "Gdiffsplit",
      "Gvdiffsplit",
      "Gread",
      "Gwrite",
      "Ggrep",
      "GMove",
      "GDelete",
      "GBrowse",
    },
  },

  {
    "folke/tokyonight.nvim",
    opts = {
      dim_inactive = true, -- dims inactive windows
      on_colors = function(c)
        c.border = c.blue0
        c.bg_dark = c.black
      end,
    },
  },

  {
    "folke/flash.nvim",
    opts = {
      modes = {
        char = {
          keys = { "f", "F", "t", "T", ";", [","] = "\\" },
        },
      },
    },
  },

  {
    "stevearc/oil.nvim",
    opts = {},
    dependencies = { "nvim-tree/nvim-web-devicons" },
    keys = {
      {
        "-",
        function()
          require("oil").open()
        end,
        desc = "Open parent directory",
      },
    },
  },
}
