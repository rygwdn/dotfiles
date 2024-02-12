return {
  {
    "vimwiki/vimwiki",
    init = function()
      vim.api.nvim_create_autocmd("FileType", {
        pattern = "vimwiki",
        desc = "Add vimwiki mappings",
        callback = function()
          vim.keymap.set("i", "[[[", "<cmd>Telescope vimwiki link<cr>", { desc = "Insert vimwiki link", buffer = true })
          vim.keymap.set("i", "::", function()
            require("telescope.builtin").symbols({ sources = { "emoji" } })
          end, { desc = "Insert emoji", buffer = true })
        end,
      })

      vim.api.nvim_create_autocmd("BufNewFile", {
        pattern = "~/Documents/notes/diary/*.md",
        desc = "diary template",
        callback = function()
          require("vimwikidiary")
          setDiaryTemplate()
        end,
      })

      vim.g.vimwiki_global_ext = 0
      vim.g.vimwiki_list = {
        {
          path = "~/Documents/notes/",
          syntax = "markdown",
          ext = ".md",
          auto_diary_index = 1,
        },
      }
    end,
  },

  { "powerman/vim-plugin-AnsiEsc", ft = "vimwiki" },
}
