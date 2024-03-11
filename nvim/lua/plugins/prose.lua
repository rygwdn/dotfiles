return {

  -- Ensure vale & marksman are installed
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

  -- Add zen-mode
  {
    "folke/zen-mode.nvim",
    cmd = { "ZenMode" },
    dependencies = {
      {
        "folke/twilight.nvim",
        cmd = { "Twilight", "TwilightEnable", "TwilightDisable" },
        opts = {},
      },
    },
    opts = {
      window = {
        width = 0.85,
        height = 0.9,
      },
      plugins = {
        kitty = {
          enabled = true,
          font = "+4",
        },
      },
    },
  },

  -- wiki-like navigation of markdown
  {
    "jakewvincent/mkdnflow.nvim",
    ft = { "markdown", "mkd" },
    opts = {
      cmp = false,
      mappings = {
        MkdnIncreaseHeading = false,
        MkdnDecreaseHeading = false,
      },
      links = {
        implicit_extension = "md",
      },
    },
  },

  {
    "vhyrro/luarocks.nvim",
    opts = {
      rocks = { "magick" },
    },
  },

  -- inline images
  {
    "3rd/image.nvim",
    ft = { "markdown", "mkd" },
    opts = {
      tmux_show_only_in_active_window = true,
      editor_only_render_when_focused = true,
      --kitty_method = "unicode-placeholders",
    },
    dependencies = {
      "nvim-lua/plenary.nvim",
      {
        "vhyrro/luarocks.nvim",
        opts = {
          rocks = { "magick" },
        },
      },
    },
  },

  -- disable bullets as they make it harder to edit headlines
  {
    "lukas-reineke/headlines.nvim",
    dependencies = "nvim-treesitter/nvim-treesitter",
    opts = {
      markdown = {
        bullets = {},
      },
    },
  },

  -- improve wrapping
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
      vim.g["pencil#wrapModeDefault"] = "soft"
      vim.api.nvim_create_autocmd({ "FileType" }, {
        pattern = "markdown,mkd",
        callback = function()
          vim.fn["pencil#init"]()
        end,
      })
    end,
  },
}
