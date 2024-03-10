return {
  {
    "jackMort/ChatGPT.nvim",
    lazy = true,
    config = function()
      require("chatgpt").setup({
        api_host_cmd = "get-openai base",
        api_key_cmd = "get-openai key",
        openai_params = {
          model = "gpt-4",
        },
      })
    end,
    cmd = { "ChatGPT", "ChatGPTActAs", "ChatGPTEditWithInstructions", "ChatGPTRun" },
    keys = {
      { "<leader>ac", "<cmd>ChatGPT<CR>", desc = "ChatGPT" },
      { "<leader>ae", "<cmd>ChatGPTEditWithInstruction<CR>", desc = "Edit with instruction", mode = { "n", "v" } },
      { "<leader>arg", "<cmd>ChatGPTRun grammar_correction<CR>", desc = "Grammar Correction", mode = { "n", "v" } },
      { "<leader>art", "<cmd>ChatGPTRun translate<CR>", desc = "Translate", mode = { "n", "v" } },
      { "<leader>ard", "<cmd>ChatGPTRun docstring<CR>", desc = "Docstring", mode = { "n", "v" } },
    },
    dependencies = {
      "MunifTanjim/nui.nvim",
      "nvim-lua/plenary.nvim",
      "folke/trouble.nvim",
      "nvim-telescope/telescope.nvim",
    },
  },
}
