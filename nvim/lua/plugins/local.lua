local local_config_path = vim.fn.expand("$HOME/.nvim.plugins.local.lua")

local file = io.open(local_config_path, "r")
if file then
  file:close()
  return dofile(local_config_path)
end

return {}
