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
config.enable_kitty_keyboard = true

-- Add wezterm terminfo with:
-- tempfile=$(mktemp) \
--  && curl -o $tempfile https://raw.githubusercontent.com/wezterm/wezterm/main/termwiz/data/wezterm.terminfo \
--  && tic -x -o ~/.terminfo $tempfile \
--  && rm $tempfile
-- (or let fish/conf.d/wezterm_terminfo.fish handle it automatically)
config.term = "wezterm"
config.keys = {}

local wez_tmux = wezterm.plugin.require("https://github.com/sei40kr/wez-tmux")
wez_tmux.apply_to_config(config, {})

local smart_splits = wezterm.plugin.require("https://github.com/mrjones2014/smart-splits.nvim")
smart_splits.apply_to_config(config, {
	direction_keys = { "h", "j", "k", "l" },
	modifiers = { move = "CTRL", resize = "META" },
})

local resurrect = wezterm.plugin.require("https://github.com/MLFlexer/resurrect.wezterm")
local local_state_path = wezterm.home_dir .. "/.local/state/wezterm/"
resurrect.state_manager.change_state_save_dir(local_state_path)
resurrect.state_manager.periodic_save({ interval_seconds = 120 })

-- Resurrect error toast notifications
wezterm.on("resurrect.error", function(err)
  wezterm.log_error("resurrect error: " .. tostring(err))
  local window = wezterm.mux.all_windows()[1]
  if window then
    window:gui_window():toast_notification("resurrect.wezterm", "Error: " .. tostring(err), nil, 4000)
  end
end)

-- Backup helpers for resurrect state files
local backup_dir = local_state_path .. "backups/"
local max_backups = 20

local function count_tabs_in_state(state_path)
  local file = io.open(state_path, "r")
  if not file then return 0 end
  local content = file:read("*a")
  file:close()
  local count = 0
  -- Count '"tabs":[' arrays and their elements via '"pane_tree"' occurrences
  for _ in content:gmatch('"pane_tree"') do
    count = count + 1
  end
  return count
end

local function backup_state_file(source_path)
  local file = io.open(source_path, "r")
  if not file then return end
  local content = file:read("*a")
  file:close()
  if #content == 0 then return end

  local tab_count = count_tabs_in_state(source_path)
  local workspace = wezterm.mux.get_active_workspace() or "default"
  local date_str = os.date("%Y-%m-%d")
  local time_str = os.date("%H%M%S")

  -- De-dupe: skip if a same-day file with identical tab count already exists
  local ok, entries = pcall(wezterm.read_dir, backup_dir)
  if ok and entries then
    local pattern = workspace .. "_" .. date_str .. ".*_" .. tostring(tab_count) .. "tabs"
    for _, entry in ipairs(entries) do
      if entry:match(pattern) then
        return -- duplicate exists
      end
    end
  end

  -- Ensure backup directory exists
  os.execute('mkdir -p "' .. backup_dir .. '"')

  local backup_name = workspace .. "_" .. date_str .. "_" .. time_str .. "_" .. tab_count .. "tabs.json"
  local dest = backup_dir .. backup_name
  local out = io.open(dest, "w")
  if out then
    out:write(content)
    out:close()
    wezterm.log_info("resurrect backup: " .. backup_name)
  end

  -- Prune old backups (keep last max_backups)
  local ok2, all_entries = pcall(wezterm.read_dir, backup_dir)
  if ok2 and all_entries then
    -- Filter to only .json backup files and sort alphabetically (oldest first)
    local backups = {}
    for _, entry in ipairs(all_entries) do
      if entry:match("%.json$") then
        table.insert(backups, entry)
      end
    end
    table.sort(backups)
    while #backups > max_backups do
      os.remove(backups[1])
      table.remove(backups, 1)
    end
  end
end

-- Maximize the default workspace window on startup and display changes
local function maximize_default_workspace()
  local mux = wezterm.mux
  local workspace = mux.get_active_workspace()
  for _, window in ipairs(mux.all_windows()) do
    if window:get_workspace() == workspace then
      window:gui_window():maximize()
    end
  end
end

wezterm.on("gui-startup", function(cmd)
  -- Backup existing state BEFORE restore can overwrite it
  local state_file = local_state_path .. "workspace/default.json"
  backup_state_file(state_file)
  resurrect.state_manager.resurrect_on_gui_startup(cmd)
end)

wezterm.on("gui-shutdown", function()
  -- Save current state then back it up
  local state = resurrect.workspace_state.get_workspace_state()
  resurrect.state_manager.save_state(state)
  local state_file = local_state_path .. "workspace/default.json"
  backup_state_file(state_file)
end)

wezterm.on("gui-attached", function(_domain)
  maximize_default_workspace()
end)

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

local modal_url = "https://github.com/rygwdn/modal.wezterm"
local modal = wezterm.plugin.require(modal_url)
modal.apply_to_config(config, modal_url)

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

config.mouse_bindings = {
  {
    event = { Down = { streak = 4, button = 'Left' } },
    action = wezterm.action.SelectTextAtMouseCursor 'SemanticZone',
    mods = 'NONE',
  },
  -- Require cmd+click to open links
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'SUPER',
    action = act.OpenLinkAtMouseCursor,
  },
  -- Disable default click-to-open link behavior
  {
    event = { Up = { streak = 1, button = 'Left' } },
    mods = 'NONE',
    action = act.CompleteSelection 'ClipboardAndPrimarySelection',
  },
}


local keys = {
	{ key = "a", mods = "LEADER|CTRL", action = act.ActivateLastTab },
	{ key = "a", mods = "LEADER", action = act.SendKey(config.leader) },
	{ key = "Escape", mods = "LEADER", action = modal.activate_mode("copy_mode") },

	{ key = "-", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "_", mods = "LEADER", action = act({ SplitVertical = { domain = "CurrentPaneDomain" } }) },
	{ key = "\\", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },
	{ key = "|", mods = "LEADER", action = act({ SplitHorizontal = { domain = "CurrentPaneDomain" } }) },

	{ key = "Space", mods = "LEADER", action = act.QuickSelect },

	-- Disable default Alt+Enter fullscreen toggle
	{ key = "Enter", mods = "ALT", action = act.DisableDefaultAssignment },

	{ key = "p", mods = "CMD|SHIFT", action = act.ActivateCommandPalette },
	{ key = "k", mods = "CMD", action = act.ActivateCommandPalette },

	{
		key = "t",
		mods = "CMD|SHIFT",
		action = act({ ShowLauncherArgs = { flags = "TABS|LAUNCH_MENU_ITEMS|DOMAINS" } }),
	},
	{ key = "LeftArrow", mods = "CMD", action = wezterm.action.SendKey({ key = "Home" }) },
	{ key = "RightArrow", mods = "CMD", action = wezterm.action.SendKey({ key = "End" }) },

	{ key = "Space", mods = "CTRL", action = wezterm.action.ShowTabNavigator },

	-- Copy the previous prompt + its output using semantic zones (requires OSC 133 shell integration)
	{
		key = "c",
		mods = "CMD|SHIFT",
		action = wezterm.action_callback(function(window, pane)
			local zones = pane:get_semantic_zones()
			if not zones or #zones == 0 then
				window:toast_notification("wezterm", "No semantic zones found (is OSC 133 shell integration enabled?)", nil, 3000)
				return
			end

			-- Helper: extract text for a single zone and trim trailing whitespace.
			local function zone_text(z)
				local t = pane:get_text_from_region(z.start_x, z.start_y, z.end_x, z.end_y) or ""
				return (t:gsub("%s+$", ""))
			end

			-- Walk backwards through Output zones to find the most recent NON-EMPTY one.
			-- This skips past empty outputs from things like hitting Enter on an empty prompt.
			-- We also skip the very last zone if it's an Output that's still being produced
			-- by the current command (its end position tracks the cursor).
			local output_idx
			for i = #zones, 1, -1 do
				if zones[i].semantic_type == "Output" and zone_text(zones[i]) ~= "" then
					output_idx = i
					break
				end
			end
			if not output_idx then
				window:toast_notification("wezterm", "No previous non-empty output found", nil, 3000)
				return
			end

			-- Walk backwards to find the Prompt zone that started this command.
			local start_idx = output_idx
			for i = output_idx - 1, 1, -1 do
				if zones[i].semantic_type == "Prompt" then
					start_idx = i
					break
				end
				start_idx = i
			end

			local start_zone = zones[start_idx]
			local end_zone = zones[output_idx]
			local text = pane:get_text_from_region(
				start_zone.start_x, start_zone.start_y,
				end_zone.end_x, end_zone.end_y
			)
			-- Trim trailing whitespace/newlines from the captured region.
			text = (text or ""):gsub("%s+$", "")
			if text == "" then
				window:toast_notification("wezterm", "Previous prompt + output was empty", nil, 2000)
				return
			end
			window:copy_to_clipboard(text, "ClipboardAndPrimarySelection")
			window:toast_notification("wezterm", "Copied previous prompt + output (" .. #text .. " chars)", nil, 2000)
		end),
	},

  {
    key = "r",
    mods = "ALT",
    action = wezterm.action_callback(function(win, pane)
      resurrect.fuzzy_loader.fuzzy_load(win, pane, function(id, label)
        local type = string.match(id, "^([^/]+)") -- match before '/'
        id = string.match(id, "([^/]+)$") -- match after '/'
        id = string.match(id, "(.+)%..+$") -- remove file extention
        local opts = {
          relative = true,
          restore_text = true,
          on_pane_restore = resurrect.tab_state.default_on_pane_restore,
        }
        if type == "workspace" then
          local state = resurrect.state_manager.load_state(id, "workspace")
          resurrect.workspace_state.restore_workspace(state, opts)
        elseif type == "window" then
          local state = resurrect.state_manager.load_state(id, "window")
          resurrect.window_state.restore_window(pane:window(), state, opts)
        elseif type == "tab" then
          local state = resurrect.state_manager.load_state(id, "tab")
          resurrect.tab_state.restore_tab(pane:tab(), state, opts)
        end
      end)
    end),
  },
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
