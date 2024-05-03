return {
  {
    "folke/noice.nvim",
    cond = not vim.g.started_by_firenvim and not vim.g.vscode,
  },

  {
    "glacambre/firenvim",
    lazy = not vim.g.started_by_firenvim,
    build = function()
      vim.fn["firenvim#install"](0)
    end,
    config = function()
      vim.api.nvim_create_autocmd({ "BufEnter" }, {
        pattern = "logs.shopify.io*.txt",
        callback = function()
          vim.opt.filetype = "splunk"
        end,
      })

      vim.api.nvim_create_autocmd({ "BufEnter" }, {
        pattern = "github.com_*.txt",
        callback = function()
          vim.opt.filetype = "markdown"
        end,
      })

      vim.api.nvim_create_autocmd({ "UIEnter" }, {
        callback = function(event)
          local client = vim.api.nvim_get_chan_info(vim.v.event.chan).client
          if client ~= nil and client.name == "Firenvim" then
            vim.o.laststatus = 0
            vim.opt.guifont = "Monaco Nerd Font:h18"

            -- Workaround for https://github.com/glacambre/firenvim/issues/800
            vim.defer_fn(function()
              vim.opt.guifont = "Monaco Nerd Font:h18"
            end, 50)
          end
        end,
      })

      if vim.fn.executable("pbpaste") == 1 then
        vim.g.clipboard = {
          name = "pbcopy",
          copy = { ["+"] = { "pbcopy" }, ["*"] = { "pbcopy" } },
          paste = { ["+"] = { "pbpaste" }, ["*"] = { "pbpaste" } },
        }
      end

      vim.g.firenvim_config = {
        globalSettings = {
          alt = "all",
        },
        localSettings = {
          [".*"] = {
            cmdline = "firenvim",
            content = "text",
            priority = 0,
            takeover = "never",
          },
          -- [".*github.com.*"] = {
          --   takeover = "always",
          --   selector = "textarea:not([readonly])",
          -- },
        },
      }
    end,
  },
}
