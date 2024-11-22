local wezterm = require("wezterm")
local act = wezterm.action

local config = wezterm.config_builder()

-- Keys
config.leader = { key = "a", mods = "CTRL" }
config.keys = {}

local wez_tmux = wezterm.plugin.require("https://github.com/sei40kr/wez-tmux")
wez_tmux.apply_to_config(config, {})

local smart_splits = wezterm.plugin.require("https://github.com/mrjones2014/smart-splits.nvim")
smart_splits.apply_to_config(config, {
  direction_keys = { "h", "j", "k", "l" },
  modifiers = { move = "CTRL", resize = "META" },
})

local modal = wezterm.plugin.require("https://github.com/MLFlexer/modal.wezterm")
modal.apply_to_config(config)

local keys = {
  { key = "a",          mods = "LEADER|CTRL", action = act.ActivateLastTab },
  { key = "a",          mods = "LEADER",      action = act.SendKey(config.leader) },
  { key = "Escape",     mods = "LEADER",      action = modal.activate_mode("copy_mode") },

  { key = "-",          mods = "LEADER",      action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
  { key = "_",          mods = "LEADER",      action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
  { key = "\\",         mods = "LEADER",      action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },
  { key = "|",          mods = "LEADER",      action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },

  { key = "Space",      mods = "LEADER",      action = act.QuickSelect },

  { key = "p",          mods = "CMD|SHIFT",   action = act.ActivateCommandPalette },
  { key = "k",          mods = "CMD",         action = act.ActivateCommandPalette },

  { key = "t",          mods = "CMD|SHIFT",   action = act({ ShowLauncherArgs = { flags = 'TABS|LAUNCH_MENU_ITEMS|DOMAINS' } }) },
  { key = 'LeftArrow',  mods = 'CMD',         action = wezterm.action.SendKey { key = 'Home' }, },
  { key = 'RightArrow', mods = 'CMD',         action = wezterm.action.SendKey { key = 'End' }, },
}

for _, key in ipairs(keys) do
  table.insert(config.keys, key)
end

wezterm.on("update-right-status", function(window, _)
  modal.set_right_status(window)
end)

table.insert(config.key_tables.copy_mode, {
  key = 'y',
  mods = 'SHIFT',
  action = act.Multiple {
    { CopyTo = 'ClipboardAndPrimarySelection' },
    { CopyMode = 'Close' },
    { PasteFrom = 'Clipboard' },
  },
})
table.insert(config.key_tables.copy_mode, {
  key = 'y',
  mods = 'NONE',
  action = act.Multiple {
    { CopyTo = 'ClipboardAndPrimarySelection' },
    { CopyMode = 'Close' },
  },
})

-- Style
config.color_scheme = "Catppuccin Mocha"
config.font = wezterm.font_with_fallback({ "Monaco", "JetBrains Mono" })

config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.tab_max_width = 64

local function tab_title(tab_info)
  local title = tab_info.tab_title
  -- if the tab title is explicitly set, take that
  if title and #title > 0 then
    return title
  end

  -- Otherwise, use the title from the active pane
  -- in that tab
  local pane = tab_info.active_pane
  if pane.domain_name and pane.domain_name ~= "unix" then
    return pane.title .. ' - (' .. pane.domain_name .. ')'
  end

  return pane.title
end

wezterm.on(
  'format-tab-title',
  function(tab, tabs, panes, config, hover, max_width)
    local title = tab_title(tab)

    return string.format(" %s: %s ", tab.tab_index + 1, title)
  end
)

wezterm.on('update-status', function(window, pane)
  -- Each element holds the text for a cell in a "powerline" style << fade
  local cells = {}

  local cwd_uri = pane:get_current_working_dir()
  if cwd_uri and type(cwd_uri) == 'userdata' then
    local cwd = cwd_uri.file_path
    table.insert(cells, cwd)
  end

  local domain = pane:get_domain_name()
  if domain and domain ~= "unix" then
    table.insert(cells, domain)
  else
    table.insert(cells, '')
  end

  -- I like my date/time in this style: "Wed Mar 3 08:14"
  local date = wezterm.strftime '%Y-%m-%d %H:%M'
  table.insert(cells, date)

  -- An entry for each battery (typically 0 or 1 battery)
  for _, b in ipairs(wezterm.battery_info()) do
    table.insert(cells, string.format('%.0f%%', b.state_of_charge * 100))
  end

  -- Color palette for the backgrounds of each cell
  local colors = {
    '#3c1361',
    '#52307c',
    '#663a82',
    '#7c5295',
    '#b491c8',
  }

  -- Foreground color for the text across the fade
  local text_fg = '#c0c0c0'

  -- The elements to be formatted
  local elements = {}
  -- How many cells have been formatted
  local num_cells = 0

  -- Translate a cell into elements
  local function push(text)
    local cell_no = num_cells + 1
    if text ~= '' then
      table.insert(elements, { Foreground = { Color = colors[cell_no] } })
      table.insert(elements, { Text = wezterm.nerdfonts.pl_right_hard_divider })

      table.insert(elements, { Foreground = { Color = text_fg } })
      table.insert(elements, { Background = { Color = colors[cell_no] } })
      table.insert(elements, { Text = ' ' .. text .. ' ' })
    end
    num_cells = num_cells + 1
  end

  while #cells > 0 do
    local cell = table.remove(cells, 1)
    push(cell)
  end

  window:set_right_status(wezterm.format(elements))
end)

-- Mux
config.unix_domains = { { name = "unix" } }
config.default_gui_startup_args = { "connect", "unix" }

-- Local config
local local_config_path = wezterm.home_dir .. "/.wezterm.local.lua"
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
