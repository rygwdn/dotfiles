return {
  {
    "ojroques/nvim-osc52",
    config = function()
      local osc = require("osc52")

      osc.setup({ silent = true })

      local function copy(lines, _)
        osc.copy(table.concat(lines, "\n"))
      end

      local function paste()
        return { vim.fn.split(vim.fn.getreg(""), "\n"), vim.fn.getregtype("") }
      end

      if vim.fn.executable("pbpaste") == 1 then
        vim.g.clipboard = {
          name = "osc52 copy",
          copy = { ["+"] = copy, ["*"] = copy },
          paste = { ["+"] = paste, ["*"] = paste },
        }
      end
    end,
  },
}
