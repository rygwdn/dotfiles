return {
  {
    "telescope.nvim",
    dependencies = {
      "ElPiloto/telescope-vimwiki.nvim",
      keys = {
        {
          "<leader>wf",
          function()
            require("telescope").extensions.vimwiki.vimwiki()
          end,
          desc = "Find Wiki Page",
        },
        {
          "<leader>wg",
          function()
            require("telescope").extensions.vimwiki.live_grep()
          end,
          desc = "Grep Wiki Pages",
        },
      },
      config = function()
        require("telescope").load_extension("vimwiki")
      end,
    },
  },
}
