local focus_defaults = {
  render_markdown = {
    code = { sign = false, width = "block", right_pad = 1, border = "thin" },
    heading = {
      sign = false,
      icons = {},
      backgrounds = {},
      border = false,
      position = "overlay",
    },
    checkbox = { enabled = false },
    anti_conceal = { enabled = true },
    paragraph = { left_margin = 0 },
    quote = { repeat_linebreak = false },
    pipe_table = { preset = "none" },
    win_options = {
      conceallevel = { default = vim.o.conceallevel, rendered = 3 },
      wrap = { default = true, rendered = false },
      linebreak = { default = true, rendered = false },
      breakindent = { default = true, rendered = false },
    },
  },
}

local focus_overrides = {
  render_markdown = {
    code = { sign = true, width = "full", right_pad = 0, border = "thin" },
    heading = {
      sign = true,
      signs = { "󰲡", "󰲣", "󰲥", "󰲧", "󰲩", "󰲫" },
      icons = { "" },
      position = "inline",
      backgrounds = {
        "RenderMarkdownH1Bg",
        "RenderMarkdownH2Bg",
        "RenderMarkdownH3Bg",
        "RenderMarkdownH4Bg",
        "RenderMarkdownH5Bg",
        "RenderMarkdownH6Bg",
      },
      border = true,
    },
    checkbox = { enabled = true, bullet = true },
    html = { comment = { conceal = false } },
    anti_conceal = { enabled = false },
    paragraph = { left_margin = 0 },
    bullet = { left_pad = 1 },
    dash = { left_margin = 0 },
    quote = { repeat_linebreak = true },
    pipe_table = { preset = "round" },
    win_options = {
      conceallevel = { default = vim.o.conceallevel, rendered = 3 },
      wrap = { default = true, rendered = true },
      linebreak = { default = true, rendered = true },
      breakindent = { default = true, rendered = true },
      breakindentopt = { default = "list:-1", rendered = "list:-1" },
    },
  },
}

return {
  {
    "MeanderingProgrammer/render-markdown.nvim",
    opts = function(_, opts)
      opts.heading = vim.tbl_extend("force", opts.heading or {}, { backgrounds = {} })

      vim.api.nvim_create_autocmd("FileType", {
        pattern = { "markdown", "norg", "rmd", "org" },
        callback = function(ev)
          local buf = ev.buf
          local win = vim.api.nvim_get_current_win()

          -- Apply focus mode by default
          vim.b[buf].markdown_focus = true
          vim.wo[win].number = false
          vim.wo[win].relativenumber = false
          vim.wo[win].cursorline = false
          vim.wo[win].signcolumn = "yes:1"
          vim.diagnostic.enable(false, { bufnr = buf })
          require("render-markdown").setup(focus_overrides.render_markdown)

          -- Smart link opener: extracts URL from [text](url) or falls back to gx
          vim.keymap.set("n", "gx", function()
            local line = vim.api.nvim_get_current_line()
            local col = vim.api.nvim_win_get_cursor(0)[2] + 1

            -- Walk all markdown links on the line, find one whose range covers the cursor
            for text, url in line:gmatch("%[([^%]]*)%]%(([^%)]+)%)") do
              local s = line:find("%[" .. vim.pesc(text) .. "%]%(" .. vim.pesc(url) .. "%)", 1, false)
              if s then
                local e = s + #text + #url + 3 -- [text](url)
                if col >= s and col <= e then
                  vim.ui.open(url)
                  return
                end
              end
            end

            -- Fallback: open URL/path under cursor
            vim.ui.open(vim.fn.expand("<cfile>"))
          end, { buffer = buf, desc = "Open link" })

          vim.keymap.set("n", "<leader>uf", function()
            local focused = not vim.b[buf].markdown_focus
            vim.b[buf].markdown_focus = focused
            win = vim.api.nvim_get_current_win()

            if focused then
              vim.wo[win].number = false
              vim.wo[win].relativenumber = false
              vim.wo[win].cursorline = false
              vim.wo[win].signcolumn = "yes:1"
              vim.diagnostic.enable(false, { bufnr = buf })
              require("render-markdown").setup(focus_overrides.render_markdown)
            else
              vim.wo[win].number = true
              vim.wo[win].relativenumber = true
              vim.wo[win].cursorline = true
              vim.wo[win].signcolumn = "auto"
              vim.diagnostic.enable(true, { bufnr = buf })
              require("render-markdown").setup(focus_defaults.render_markdown)
            end

            vim.notify(focused and "  Markdown focus on" or "  Markdown focus off", vim.log.levels.INFO)
          end, { buffer = buf, desc = "Toggle Markdown Focus Mode" })
        end,
      })
    end,
  },
}
