return {
  {
    "ojroques/nvim-osc52",
    lazy = vim.g.started_by_firenvim,
    config = function()
      local osc = require("osc52")
      osc.setup({ silent = true })

      local last_copy = 0
      local function copy(lines, _)
        last_copy = vim.loop.now()
        osc.copy(table.concat(lines, "\n"))
      end

      local function paste()
        -- paste from clipboard if last copy was more than 1s ago. This keeps quick copy/paste flows quick but keeps us in sync with the clipboard
        if (vim.loop.now() - last_copy) > 1000 then
          local value = vim.fn.system("pbpaste")
          vim.fn.setreg("", value)
        end

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
  {
    "HakonHarnes/img-clip.nvim",
    ft = { "markdown" },
    cmd = {
      "PasteImage",
    },
    opts = {
      dirs = {
        ["~/Documents/notes/"] = {
          prompt_for_file_name = false,
        },
      },
    },
    keys = {
      { "<leader>p", "<cmd>PasteImage<cr>", desc = "Paste clipboard image" },
    },
  },
}
