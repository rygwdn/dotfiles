return {
  {
    "folke/snacks.nvim",
    opts = function(_, opts)
      table.insert(opts.dashboard.preset.keys, 3, {
        icon = " ", key = "p", action = ':ene | normal "+p', desc = "New from Clipboard"
      })
      opts.dashboard.sections = {
        -- { section = "header" },
        { section = "keys", gap = 1, padding = 1 },
        { pane = 2, icon = " ", title = "Recent Files", section = "recent_files", indent = 2, padding = 1 },
        { pane = 2, icon = " ", title = "Projects", section = "projects", indent = 2, padding = 1 },
        {
          pane = 2,
          icon = " ",
          title = "Git Status",
          section = "terminal",
          enabled = Snacks.git.get_root() ~= nil,
          cmd =
          "[[ -f \"$(git rev-parse --show-toplevel)/.git/.graphite_repo_config\" ]] && gt log short -sa || git status --short --branch --renames",
          height = 5,
          padding = 1,
          ttl = 5 * 60,
          indent = 3,
        },
        { section = "startup" },
      }
    end,
  }
}
