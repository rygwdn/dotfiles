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

local keys = {
	{ key = "a", mods = "LEADER|CTRL", action = act.ActivateLastTab },
	{ key = "a", mods = "LEADER", action = act.SendKey(config.leader) },
	{ key = "Escape", mods = "LEADER", action = act.ActivateCopyMode },

	{ key = "-", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "_", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "\\", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },
	{ key = "|", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },

	{ key = "Space", mods = "LEADER", action = act.QuickSelect },

	{ key = "p", mods = "CMD|SHIFT", action = act.ActivateCommandPalette },
	{ key = "k", mods = "CMD", action = act.ActivateCommandPalette },
}

for _, key in ipairs(keys) do
	table.insert(config.keys, key)
end

-- Style
config.color_scheme = "Catppuccin Mocha"
config.font = wezterm.font_with_fallback({ "Monaco", "JetBrains Mono" })

config.hide_tab_bar_if_only_one_tab = true
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = true

-- Mux
config.unix_domains = { { name = "unix" } }
config.default_gui_startup_args = { "connect", "unix" }

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
