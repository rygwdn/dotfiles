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
    "mfussenegger/nvim-lint",
    opts = {
      linters_by_ft = {
        vimwiki = { "vale" },
      },
    },
  },

  { "tpope/vim-eunuch", vscode = true },
  { "tpope/vim-git" },
  { "tpope/vim-fugitive" },

  {
    "rygwdn/vim-tmux-navigator",
    cmd = {
      "TmuxNavigateLeft",
      "TmuxNavigateDown",
      "TmuxNavigateUp",
      "TmuxNavigateRight",
      "TmuxNavigatePrevious",
    },
    keys = {
      { "<c-h>", "<cmd><C-U>TmuxNavigateLeft<cr>" },
      { "<c-j>", "<cmd><C-U>TmuxNavigateDown<cr>" },
      { "<c-k>", "<cmd><C-U>TmuxNavigateUp<cr>" },
      { "<c-l>", "<cmd><C-U>TmuxNavigateRight<cr>" },
      { "<c-\\>", "<cmd><C-U>TmuxNavigatePrevious<cr>" },
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
