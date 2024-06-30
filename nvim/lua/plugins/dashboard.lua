return {
  {
    "nvimdev/dashboard-nvim",
    opts = function(_, opts)
      table.insert(opts.config.center, 3, { action = 'ene | normal "+p', desc = " New from Clipboard", icon = " ", key = "p" })
    end,
  },
}
