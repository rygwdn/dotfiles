-- require "grid"
hydra.douserfile("grid")

ext.grid.MARGINX = 2
ext.grid.MARGINY = 2
ext.grid.GRIDWIDTH = 2

hydra.alert("Hydra running", 1.5)

-- Watch for changes to these files..
pathwatcher.new(os.getenv("HOME") .. "/.hydra/", hydra.reload):start()
autolaunch.set(true)

-- show a helpful menu
menu.show(function()
    local updatetitles = {[true] = "Install Update", [false] = "Check for Update..."}
    local updatefns = {[true] = updates.install, [false] = updates.check}
    local hasupdate = (updates.newversion ~= nil)

    return {
      {title = "Reload Config", fn = hydra.reload},
      {title = "-"},
      {title = "About", fn = hydra.showabout},
      {title = updatetitles[hasupdate], fn = updatefns[hasupdate]},
      {title = "Quit Hydra", fn = os.exit},
    }
end)


local hyper = {"cmd", "alt", "ctrl"}
local shyper = {"cmd", "alt", "ctrl", "shift"}

local help_keys = {}

function bind_help(meta, key, help, func)
  local meta_name
  if meta == shyper then
    meta_name = "S+hyper"
  elseif meta == hyper then
    meta_name = "hyper"
  else
    meta_name = table.concat(meta, "+")
  end

  table.insert(help_keys, {
    keys = meta_name .. "+" .. key,
    help = help
  })
  hotkey.bind(meta, key, func)
end

function key_lines()
  local lines = {}
  local length = 0
  for _, info in pairs(help_keys) do
    if info.keys:len() > length then
      length = info.keys:len()
    end
  end

  for _, info in pairs(help_keys) do
    local line = info.keys
    while line:len() < length + 2 do
      line = line .. " "
    end
    line = line .. info.help

    table.insert(lines, line)
  end
  return lines
end


bind_help(hyper, "X", "Show the logger", logger.show)
bind_help(hyper, "R", "Show the repl", repl.open)

-- Snap current window to grid
bind_help(hyper, ';', "Snap current window to grid.", function() ext.grid.snap(window.focusedwindow()) end)
-- Snap all windows to grid
bind_help(hyper, "'", "Snap all windows to grid", function() fnutils.map(window.visiblewindows(), ext.grid.snap) end)

-- Increase/decrease the width of the grid
bind_help(hyper, '=', "Increase grid width", function() ext.grid.adjustwidth( 1) end)
bind_help(hyper, '-', "Decrease grid width", function() ext.grid.adjustwidth(-1) end)

-- Focus in 4 directions (navigate grid)
bind_help(shyper, 'H', "Focus window to west.", function() window.focusedwindow():focuswindow_west() end)
bind_help(shyper, 'L', "Focus window to east.", function() window.focusedwindow():focuswindow_east() end)
bind_help(shyper, 'K', "Focus window to north.", function() window.focusedwindow():focuswindow_north() end)
bind_help(shyper, 'J', "Focus window to south.", function() window.focusedwindow():focuswindow_south() end)

-- Maximize!
bind_help(hyper, 'M', "Maximize!", ext.grid.maximize_window)
bind_help(hyper, 'Return', "Maximize!", ext.grid.maximize_window)

-- Next/prev screen
bind_help(hyper, 'N', "Push window to next screen", ext.grid.pushwindow_nextscreen)
bind_help(hyper, 'P', "Push window to previous screen", ext.grid.pushwindow_prevscreen)

-- Move within grid
bind_help(hyper, 'J', "Push window down", ext.grid.pushwindow_down)
bind_help(hyper, 'K', "Push window up", ext.grid.pushwindow_up)
bind_help(hyper, 'H', "Push window left", ext.grid.pushwindow_left)
bind_help(hyper, 'L', "Push window right", ext.grid.pushwindow_right)

-- Change size
bind_help(hyper, 'U', "Make window taller", ext.grid.resizewindow_taller)
bind_help(hyper, 'O', "Make window wider", ext.grid.resizewindow_wider)
bind_help(hyper, 'I', "Make window thinner", ext.grid.resizewindow_thinner)

keywin = nil
function showkeys()
  if keywin then
    keywin:show()
    keywin:window():focus()
    return
  end

  keywin = textgrid.create()
  keywin:protect()

  local pos = 1 -- i.e. line currently at top of log textgrid

  local fg = "00FF00"
  local bg = "222222"

  keywin:settitle("Keys!")

  local lines = key_lines()

  local function redraw()
    keywin:setbg(bg)
    keywin:setfg(fg)
    keywin:clear()

    local size = keywin:getsize()

    for linenum = pos, math.min(pos + size.h, # lines) do
      local line = lines[linenum]
      for i = 1, math.min(#line, size.w) do
        local c = line:sub(i,i)
        keywin:setchar(c, i, linenum - pos + 1)
      end
    end
  end

  keywin:resized(redraw)

  local function handlekey(t)
    local size = keywin:getsize()
    local h = size.h

    -- this can't be cached on account of the textgrid's height could change
    local keytable = {
      j = 1,
      k = -1,
      n = (h-1),
      p = -(h-1),
    }

    local scrollby = keytable[t.key]
    if scrollby then
      pos = pos + scrollby
      pos = math.min(pos, # lines - h)
      pos = math.max(pos, 1)
    else
      keywin:window():close()
    end
    redraw()
  end

  keywin:keydown(handlekey)

  redraw()
  keywin:focus()

  return keywin
end
bind_help(hyper, "/", "show key help", showkeys)

updates.check()
