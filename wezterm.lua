-- Pull in the wezterm API
local wezterm = require 'wezterm'
local act = wezterm.action

local config = wezterm.config_builder()

config.color_scheme = 'Catppuccin Mocha'
--config.font_size = 10.0
config.hide_tab_bar_if_only_one_tab = true
config.font = wezterm.font_with_fallback { 'Monaco', 'JetBrains Mono' }
config.tab_bar_at_bottom = true

config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 1000, }
config.keys = {
  { key = "a",      mods = "LEADER|CTRL", action = wezterm.action.ActivateLastTab },
  { key = 'n',      mods = 'LEADER',      action = act.ActivateTabRelative(1) },
  { key = 'p',      mods = 'LEADER',      action = act.ActivateTabRelative(-1) },

  { key = 'Escape', mods = 'LEADER',      action = act.ActivateCopyMode },
  { key = "-",      mods = "LEADER",      action = wezterm.action { SplitVertical = { domain = "CurrentPaneDomain" } } },
  { key = "\\",     mods = "LEADER",      action = wezterm.action { SplitHorizontal = { domain = "CurrentPaneDomain" } } },
  { key = "c",      mods = "LEADER",      action = wezterm.action { SpawnTab = "CurrentPaneDomain" } },
  { key = "h",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Left" } },
  { key = "j",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Down" } },
  { key = "k",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Up" } },
  { key = "l",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Right" } },
  { key = "1",      mods = "LEADER",      action = wezterm.action { ActivateTab = 0 } },
  { key = "2",      mods = "LEADER",      action = wezterm.action { ActivateTab = 1 } },
  { key = "3",      mods = "LEADER",      action = wezterm.action { ActivateTab = 2 } },
  { key = "4",      mods = "LEADER",      action = wezterm.action { ActivateTab = 3 } },
  { key = "5",      mods = "LEADER",      action = wezterm.action { ActivateTab = 4 } },
  { key = "6",      mods = "LEADER",      action = wezterm.action { ActivateTab = 5 } },
  { key = "7",      mods = "LEADER",      action = wezterm.action { ActivateTab = 6 } },
  { key = "8",      mods = "LEADER",      action = wezterm.action { ActivateTab = 7 } },
  { key = "9",      mods = "LEADER",      action = wezterm.action { ActivateTab = 8 } },
  { key = "Space",  mods = "LEADER",      action = wezterm.action.QuickSelect },

  { key = 'p',      mods = 'CMD|SHIFT',   action = act.ActivateCommandPalette },
  { key = 'k',      mods = 'CMD',         action = act.ActivateCommandPalette },
  { key = 'h',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Left', },
  { key = 'l',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Right', },
  { key = 'k',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Up', },
  { key = 'j',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Down', },
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
}

local unix_domains = {}
local success, stdout, _ = wezterm.run_child_process { '/usr/local/bin/spin', 'ls', '--json' }
if success then
  local instances = wezterm.json_parse(stdout)
  for _, dom in ipairs(instances) do
    local _, jsoncmd, _ = wezterm.run_child_process { "/usr/local/bin/spin", "shell", "--show", "--json", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" }
    local cmd = wezterm.json_parse(jsoncmd).sshargs
    table.insert(cmd, 1, 'ssh')

    table.insert(unix_domains, {
      name = 'spin-' .. dom.name,
      no_serve_automatically = true,
      --proxy_command = { "/usr/local/bin/spin", "shell", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" },
      proxy_command = cmd,
    })
  end
end

-- for i = 1, 10 do
--   table.insert(unix_domains, {
--     name = 'spin-' .. i,
--     no_serve_automatically = true,
--     proxy_command = { "spin", "shell", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" },
--   })
-- end

config.unix_domains = unix_domains

-- function setDom(label)
--   for domi, dom in ipairs(config.unix_domains) do
--     --wezterm.log_info('yyy ' .. domi .. ':' .. dom.proxy_command[3])
--     if dom.proxy_command[3] == 'DOMAIN' then
--       wezterm.log_info('found EMPTY ' .. domi)
--       config.unix_domains[domi].proxy_command[3] = label
--       return
--     elseif dom.proxy_command[3] == label then
--       wezterm.log_info('found ' .. label .. ' at ' .. domi)
--       return
--     else
--       wezterm.log_info('nah ' .. label .. ' at ' .. domi .. ' found ' .. dom.proxy_command[3])
--     end
--   end
-- end

config.use_fancy_tab_bar = false
-- -- The filled in variant of the < symbol
-- local SOLID_LEFT_ARROW = wezterm.nerdfonts.pl_right_hard_divider
--
-- -- The filled in variant of the > symbol
-- local SOLID_RIGHT_ARROW = wezterm.nerdfonts.pl_left_hard_divider
--
-- config.tab_bar_style = {
--   active_tab_left = wezterm.format {
--     { Background = { Color = '#0b0022' } },
--     { Foreground = { Color = '#2b2042' } },
--     { Text = SOLID_LEFT_ARROW },
--   },
--   active_tab_right = wezterm.format {
--     { Background = { Color = '#0b0022' } },
--     { Foreground = { Color = '#2b2042' } },
--     { Text = SOLID_RIGHT_ARROW },
--   },
--   inactive_tab_left = wezterm.format {
--     { Background = { Color = '#0b0022' } },
--     { Foreground = { Color = '#1b1032' } },
--     { Text = SOLID_LEFT_ARROW },
--   },
--   inactive_tab_right = wezterm.format {
--     { Background = { Color = '#0b0022' } },
--     { Foreground = { Color = '#1b1032' } },
--     { Text = SOLID_RIGHT_ARROW },
--   },
-- }






-- wezterm.add_to_config_reload_watch_list(path)
-- local success, stdout, stderr = wezterm.run_child_process { 'ls', '-l' }
--
-- return {
--   window_background_image = '/home/wez/Downloads/sunset-american-fork-canyon.jpg',
--   keys = {
--     {
--       mods = 'CTRL|SHIFT',
--       key = 'm',
--       action = wezterm.action_callback(function(win, pane)
--         wezterm.background_child_process {
--           'xdg-open',
--           win:effective_config().window_background_image,
--         }
--       end),
--     },
--   },
-- }


-- and finally, return the configuration to wezterm
return config
