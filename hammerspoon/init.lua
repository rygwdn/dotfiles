local u = require("utils")

--local cmd2 = { "command", "ctrl" }

-- for more apps, run
-- $ ls /Applications
hs.hotkey.bind({}, "F1", u.toggleApp("Kitty"))
hs.hotkey.bind({ "shift" }, "F1", u.toggleApp("Obsidian"))

--hs.hotkey.bind(cmd2, "1", u.weakFocus("Slack"))
--hs.hotkey.bind(cmd2, "2", u.focusApp("Google Chrome"))
--hs.hotkey.bind(cmd2, "3", u.weakFocus("IntelliJ IDEA"))
--hs.hotkey.bind(cmd2, "4", u.weakFocus("Postman"))
--hs.hotkey.bind(cmd2, "9", u.focusApp("Spotify"))
--hs.hotkey.bind(cmd2, "h", u.hideAllApps)
