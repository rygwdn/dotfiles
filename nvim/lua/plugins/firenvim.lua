local spec = { -- the default when not invoked by the browser addon
  "glacambre/firenvim",
  build = function()
    vim.fn["firenvim#install"](0)
  end,
  module = false, -- prevent other code to require("firenvim")
  lazy = true,    -- never load, except when lazy.nvim is building the plugin
}

if vim.g.started_by_firenvim == true then -- set by the browser addon
  spec = {
    { "noice.nvim",   cond = false },     -- can't work with gui having ext_cmdline
    { "lualine.nvim", cond = false },     -- not useful in the browser
    vim.tbl_extend("force", spec, {
      lazy = false,                       -- must load at start in browser
      config = function(opts)
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
          },
        }

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
      end,
    }),
  }
end

return spec
