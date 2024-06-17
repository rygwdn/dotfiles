-- Pull in the wezterm API
local wezterm = require 'wezterm'
local act = wezterm.action

local config = wezterm.config_builder()

config.color_scheme = 'Catppuccin Mocha'
--config.font_size = 10.0
config.hide_tab_bar_if_only_one_tab = true
config.font = wezterm.font_with_fallback { 'Monaco', 'JetBrains Mono' }

config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 1000, }
config.keys = {
  { key = "a",      mods = "LEADER|CTRL", action = wezterm.action { SendString = "\x01" } },
  { key = 'Escape', mods = 'LEADER',      action = act.ActivateCopyMode },
  { key = "-",      mods = "LEADER",      action = wezterm.action { SplitVertical = { domain = "CurrentPaneDomain" } } },
  { key = "\\",     mods = "LEADER",      action = wezterm.action { SplitHorizontal = { domain = "CurrentPaneDomain" } } },
  { key = "c",      mods = "LEADER",      action = wezterm.action { SpawnTab = "CurrentPaneDomain" } },
  { key = "h",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Left" } },
  { key = "j",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Down" } },
  { key = "k",      mods = "LEADER",      action = wezterm.action { ActivatePaneDirection = "Up" } },
  -- TODO: n/p
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
}


local success, stdout, stderr = wezterm.run_child_process { 'spin', 'ls', '--json' }

--wezterm.log_info(success, stdout, stderr)
local unix_domains = {}

if (success) then
  local instances = wezterm.json_parse(stdout)
  for _, dom in ipairs(instances) do
    table.insert(unix_domains, {
      name = 'spin-' .. dom.name,
      no_serve_automatically = true,
      -- should install wezterm binary in system path(eg. /usr/bin/wezterm)
      proxy_command = { "spin", "shell", dom.name, "--", "-T", "-A", "wezterm", "cli", "proxy" },
    })
  end
end

config.unix_domains = unix_domains

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
