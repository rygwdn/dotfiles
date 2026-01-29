local wezterm = require("wezterm")
local act = wezterm.action

local config = wezterm.config_builder()

if wezterm.run_child_process({ "/opt/homebrew/bin/fish", "--version" }) then
	config.default_prog = { "/opt/homebrew/bin/fish", "-l" }
elseif wezterm.run_child_process({ "/usr/bin/fish", "--version" }) then
	config.default_prog = { "/usr/bin/fish", "-l" }
end

config.scrollback_lines = 100000

-- Keys
config.leader = { key = "a", mods = "CTRL" }
config.keys = {
  {key="Enter", mods="SHIFT", action=wezterm.action{SendString="\x1b\r"}},
}

local wez_tmux = wezterm.plugin.require("https://github.com/sei40kr/wez-tmux")
wez_tmux.apply_to_config(config, {})

local smart_splits = wezterm.plugin.require("https://github.com/mrjones2014/smart-splits.nvim")
smart_splits.apply_to_config(config, {
	direction_keys = { "h", "j", "k", "l" },
	modifiers = { move = "CTRL", resize = "META" },
})

local resurrect = wezterm.plugin.require("https://github.com/MLFlexer/resurrect.wezterm")
resurrect.state_manager.periodic_save()
wezterm.on("gui-startup", resurrect.state_manager.resurrect_on_gui_startup)

local function nav_section(tab)
  local project = tab.active_pane.user_vars.project

  if project then
    return project
  end

  local cwd = tab.active_pane.current_working_dir
  local max_length = 10
  if cwd then
    local file_path = cwd.file_path

    -- Remove any leading and trailing slashes
    file_path = file_path:match('^/*(.-)/*$')
    local parent = file_path:match('([^/]*)/[^/]*$')
    if parent and #parent > max_length then
      parent = parent:sub(1, max_length - 1) .. '…'
    end

    cwd = file_path:match('([^/]+)/?$')
    if cwd and #cwd > max_length then
      cwd = cwd:sub(1, max_length - 1) .. '…'
    end

    return parent .. '/' .. cwd
  end

  return ''
end

local modal = wezterm.plugin.require("https://github.com/MLFlexer/modal.wezterm")
modal.apply_to_config(config)

local tabline = wezterm.plugin.require("https://github.com/michaelbrusegard/tabline.wez")
tabline.setup({
  options = {
    icons_enabled = true,
    theme = 'Catppuccin Mocha',
    tabs_enabled = true,
    theme_overrides = {},
    section_separators = {
      left = wezterm.nerdfonts.pl_left_hard_divider,
      right = wezterm.nerdfonts.pl_right_hard_divider,
    },
    component_separators = {
      left = wezterm.nerdfonts.pl_left_soft_divider,
      right = wezterm.nerdfonts.pl_right_soft_divider,
    },
    tab_separators = {
      left = wezterm.nerdfonts.pl_left_hard_divider,
      right = wezterm.nerdfonts.pl_right_hard_divider,
    },
  },
  sections = {
    tabline_a = { 'mode' },
    tabline_b = { 'workspace' },
    tabline_c = { ' ' },
    tab_active = {
      'index',
      { 'output', icon_no_output=nil },
      { 'process', icons_only=true, padding = { left = 0, right = 1 } },
      nav_section,
      { 'zoomed', padding = 0 },
    },
    tab_inactive = {
      'index',
      { 'output', icon_no_output=nil },
      { 'process', icons_only=true, padding = { left = 0, right = 1 } },
      nav_section,
    },
    --tabline_x = { 'ram', 'cpu' },
    tabline_x = {  },
    --tabline_y = { 'datetime', 'battery' },
    tabline_y = {  },
    tabline_z = { 'domain' },
  },
  extensions = { 'resurrect' },
})

tabline.apply_to_config(config)


-- update plugins:
-- wezterm.plugin.update_all() 

local keys = {
	{ key = "a", mods = "LEADER|CTRL", action = act.ActivateLastTab },
	{ key = "a", mods = "LEADER", action = act.SendKey(config.leader) },
	{ key = "Escape", mods = "LEADER", action = modal.activate_mode("copy_mode") },

	{ key = "-", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "_", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "\\", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },
	{ key = "|", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },

	{ key = "Space", mods = "LEADER", action = act.QuickSelect },

	{ key = "p", mods = "CMD|SHIFT", action = act.ActivateCommandPalette },
	{ key = "k", mods = "CMD", action = act.ActivateCommandPalette },

	{
		key = "t",
		mods = "CMD|SHIFT",
		action = act({ ShowLauncherArgs = { flags = "TABS|LAUNCH_MENU_ITEMS|DOMAINS" } }),
	},
	{ key = "LeftArrow", mods = "CMD", action = wezterm.action.SendKey({ key = "Home" }) },
	{ key = "RightArrow", mods = "CMD", action = wezterm.action.SendKey({ key = "End" }) },
}

for _, key in ipairs(keys) do
	table.insert(config.keys, key)
end

table.insert(config.key_tables.copy_mode, {
	key = "y",
	mods = "SHIFT",
	action = act.Multiple({
		{ CopyTo = "ClipboardAndPrimarySelection" },
		{ CopyMode = "Close" },
		{ PasteFrom = "Clipboard" },
	}),
})
table.insert(config.key_tables.copy_mode, {
	key = "y",
	mods = "NONE",
	action = act.Multiple({
		{ CopyTo = "ClipboardAndPrimarySelection" },
		{ CopyMode = "Close" },
	}),
})

-- Style
config.color_scheme = "Catppuccin Mocha"
config.font = wezterm.font_with_fallback({ "Monaco", "JetBrains Mono" })

config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true
config.tab_max_width = 64


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
