return {
  {
    "glacambre/firenvim",
    lazy = not vim.g.started_by_firenvim,
    build = function()
      vim.fn["firenvim#install"](0)
    end,
    config = function()
      vim.api.nvim_create_autocmd({ "BufEnter" }, {
        pattern = "logs.shopify.io*.txt",
        cmd = "set filetype=splunk",
      })

      vim.api.nvim_create_autocmd({ "UIEnter" }, {
        callback = function(event)
          local client = vim.api.nvim_get_chan_info(vim.v.event.chan).client
          if client ~= nil and client.name == "Firenvim" then
            vim.o.laststatus = 0
          end
        end,
      })

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
          [".*github.com.*"] = {
            takeover = "always",
            selector = "textarea:not([readonly])",
          },
        },
      }

      -- TODO:this
      --   function! SetFontSizeFirenvim(timer)
      --     set guifont=Monaco:h18
      --   endfunction
      --
      --   function! OnUIEnter()
      --     call timer_start(200, function("SetFontSizeFirenvim"))
      --   endfunction
      --
      --   " Workaround for https://github.com/glacambre/firenvim/issues/800
      --   autocmd UIEnter * call OnUIEnter()
      --
      --   au BufEnter github.com_*.txt set filetype=markdown
      -- endif
    end,
  },
}
