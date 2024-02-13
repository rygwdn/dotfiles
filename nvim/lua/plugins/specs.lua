return {
  { "tpope/vim-eunuch" },
  { "tpope/vim-git" },
  { "tpope/vim-fugitive" },
  { "rygwdn/vim-tmux-navigator" },

  {
    "ojroques/nvim-osc52",
    config = function()
      local osc = require("osc52")

      local function copy(lines, _)
        osc.copy(table.concat(lines, "\n"))
      end

      local paste = vim.fn.executable("pbpaste") == 1 and { "pbpaste" }
        or function()
          return { vim.fn.split(vim.fn.getreg(""), "\n"), vim.fn.getregtype("") }
        end

      if vim.fn.executable("pbpaste") == 1 then
        vim.g.clipboard = {
          name = "osc52 & pbpaste",
          copy = { ["+"] = copy, ["*"] = copy },
          paste = { ["+"] = paste, ["*"] = paste },
        }
      end
    end,
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
