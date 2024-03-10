return {
  -- TODO: look into https://github.com/nvim-orgmode/orgmode
  {
    "williamboman/mason.nvim",
    opts = {
      ensure_installed = {
        "vale",
        "vale-ls",
        "marksman",
      },
    },
  },

  {
    "lukas-reineke/headlines.nvim",
    dependencies = "nvim-treesitter/nvim-treesitter",
    config = true, -- or `opts = {}`
    opts = {
      markdown = {
        bullets = {},
      },
    },
  },

  {
    "preservim/vim-pencil",
    cmd = {
      "HardPencil",
      "SoftPencil",
      "TogglePencil",
      "Pencil",
    },
    ft = { "markdown", "mkd" },
    init = function()
      vim.api.nvim_create_autocmd({ "FileType" }, {
        pattern = "markdown,mkd",
        callback = function()
          vim.fn["pencil#init"]()
        end,
      })
    end,
  },
}
