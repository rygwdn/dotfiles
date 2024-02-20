return {
  { "tpope/vim-eunuch" },
  { "tpope/vim-git", cond = not vim.g.vscode },
  { "tpope/vim-fugitive", cond = not vim.g.vscode },
  { "rygwdn/vim-tmux-navigator", cond = not vim.g.vscode },
  { "echasnovski/mini.indentscope", cond = not vim.g.vscode },

  {
    "folke/flash.nvim",
    cond = not vim.g.vscode,
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
    cond = not vim.g.vscode,
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
