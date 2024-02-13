return {
  { "tpope/vim-eunuch" },
  { "tpope/vim-git" },
  { "tpope/vim-fugitive" },
  { "rygwdn/vim-tmux-navigator" },

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
