local wezterm = require 'wezterm'
local act = wezterm.action

local config = wezterm.config_builder()

-- Style
config.color_scheme = 'Catppuccin Mocha'
config.font = wezterm.font_with_fallback { 'Monaco', 'JetBrains Mono' }

config.hide_tab_bar_if_only_one_tab = true
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true


-- Keys
config.leader = { key = 'a', mods = 'CTRL', timeout_milliseconds = 1000, }
config.keys = {
  { key = "a",      mods = "LEADER|CTRL", action = act.ActivateLastTab },
  { key = 'n',      mods = 'LEADER',      action = act.ActivateTabRelative(1) },
  { key = 'p',      mods = 'LEADER',      action = act.ActivateTabRelative(-1) },

  { key = 'Escape', mods = 'LEADER',      action = act.ActivateCopyMode },
  { key = "-",      mods = "LEADER",      action = act { SplitVertical = { domain = "CurrentPaneDomain" } } },
  { key = "\\",     mods = "LEADER",      action = act { SplitHorizontal = { domain = "CurrentPaneDomain" } } },
  { key = "c",      mods = "LEADER",      action = act { SpawnTab = "CurrentPaneDomain" } },
  { key = "h",      mods = "LEADER",      action = act { ActivatePaneDirection = "Left" } },
  { key = "j",      mods = "LEADER",      action = act { ActivatePaneDirection = "Down" } },
  { key = "k",      mods = "LEADER",      action = act { ActivatePaneDirection = "Up" } },
  { key = "l",      mods = "LEADER",      action = act { ActivatePaneDirection = "Right" } },
  { key = "1",      mods = "LEADER",      action = act { ActivateTab = 0 } },
  { key = "2",      mods = "LEADER",      action = act { ActivateTab = 1 } },
  { key = "3",      mods = "LEADER",      action = act { ActivateTab = 2 } },
  { key = "4",      mods = "LEADER",      action = act { ActivateTab = 3 } },
  { key = "5",      mods = "LEADER",      action = act { ActivateTab = 4 } },
  { key = "6",      mods = "LEADER",      action = act { ActivateTab = 5 } },
  { key = "7",      mods = "LEADER",      action = act { ActivateTab = 6 } },
  { key = "8",      mods = "LEADER",      action = act { ActivateTab = 7 } },
  { key = "9",      mods = "LEADER",      action = act { ActivateTab = 8 } },
  { key = "Space",  mods = "LEADER",      action = act.QuickSelect },

  { key = 'p',      mods = 'CMD|SHIFT',   action = act.ActivateCommandPalette },
  { key = 'k',      mods = 'CMD',         action = act.ActivateCommandPalette },
  { key = 'h',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Left', },
  { key = 'l',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Right', },
  { key = 'k',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Up', },
  { key = 'j',      mods = 'CTRL',        action = act.ActivatePaneDirection 'Down', },
}


-- Mux
config.unix_domains = {{ name = 'unix' }}
config.default_gui_startup_args = { 'connect', 'unix' }


-- Local config
local local_config_path = wezterm.home_dir .. "/local.wezterm.lua"
wezterm.add_to_config_reload_watch_list(local_config_path)

local file = io.open(local_config_path, "r")
if file then
  file:close()
  local local_config_fn = dofile(local_config_path)
  if type(local_config_fn) == "function" then
    local_config_fn(config)
  end
end

return config
