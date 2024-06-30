return function(config)
  local exists, output = pcall(wezterm.run_child_process, { '/usr/local/bin/spin', 'ls', '--json' })
  if exists then
    local success, stdout, _ = output
    if success then

-- for i = 1, 10 do
--   table.insert(unix_domains, {
--     name = 'spin-' .. i,
--     no_serve_automatically = true,
--     proxy_command = { "spin", "shell", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" },
--   })
-- end
      --
      local instances = wezterm.json_parse(stdout)
      for _, dom in ipairs(instances) do
        local _, jsoncmd, _ = wezterm.run_child_process { "/usr/local/bin/spin", "shell", "--show", "--json", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" }
        local cmd = wezterm.json_parse(jsoncmd).sshargs
        table.insert(cmd, 1, 'ssh')

        table.insert(config.unix_domains, {
          name = 'spin-' .. dom.name,
          no_serve_automatically = true,
          --proxy_command = { "/usr/local/bin/spin", "shell", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" },
          proxy_command = cmd,
        })
      end
    end
  end

  --table.insert(config.keys, {
  -- {
  --   key = 's',
  --   mods = 'LEADER',
  --   action = wezterm.action_callback(function(window, pane)
  --     -- Here you can dynamically construct a longer list if needed
  --     --wezterm.log_info 'start'
  --     local success, stdout, stderr = wezterm.run_child_process { '/usr/local/bin/spin', 'ls', '--json' }
  --     local instances = wezterm.json_parse(stdout)
  --     local spins = {}
  --     for _, dom in ipairs(instances) do
  --       --wezterm.log_info('dom: ' .. dom.name)
  --       table.insert(spins, { id = dom.name, label = dom.name })
  --     end
  --
  --     window:perform_action(
  --       act.InputSelector {
  --         action = wezterm.action_callback(
  --           function(inner_window, inner_pane, id, label)
  --             if not id and not label then
  --               wezterm.log_info 'cancelled'
  --             else
  --               --setDom(label)
  --
  --               -- proxy_command = { "spin", "shell", "--", "-T", "-A", "wezterm", "cli", "proxy" },
  --               -- inner_window:perform_action(
  --               --   act.SwitchToWorkspace {
  --               --     name = label,
  --               --     spawn = {
  --               --       label = 'Workspace: ' .. label,
  --               --       cwd = id,
  --               --     },
  --               --   },
  --               --   inner_pane
  --               -- )
  --             end
  --           end
  --         ),
  --         title = 'Choose Instance',
  --         choices = spins,
  --         fuzzy = true,
  --         -- TODO: make instances??
  --         fuzzy_description = 'Fuzzy find instance: ',
  --       },
  --       pane
  --     )
  --   end),
  -- },
  --})
end

