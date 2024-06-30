function ss(name)
  return function(...)
    require("smart-splits")[name](...)
  end
end

return {
  {
    "mrjones2014/smart-splits.nvim",

    keys = {
      -- resizing splits
      -- these keymaps will also accept a range,
      -- for example `10<A-h>` will `resize_left` by `(10 * config.default_amount)`
      { "<A-h>", ss("resize_left"), desc = "Resize pane left" },
      { "<A-j>", ss("resize_down"), desc = "Resize pane down" },
      { "<A-k>", ss("resize_up"), desc = "Resize pane up" },
      { "<A-l>", ss("resize_right"), desc = "Resize pane right" },

      -- moving between splits
      { "<C-h>", ss("move_cursor_left"), desc = "Move to left pane" },
      { "<C-j>", ss("move_cursor_down"), desc = "Move to down pane" },
      { "<C-k>", ss("move_cursor_up"), desc = "Move to up pane" },
      { "<C-l>", ss("move_cursor_right"), desc = "Move to right pane" },
      { "<C-\\>", ss("move_cursor_previous"), desc = "Move to previous pane" },

      -- swapping buffers between windows
      { "<leader><leader>h", ss("swap_buf_left"), desc = "Swap with left buffer" },
      { "<leader><leader>j", ss("swap_buf_down"), desc = "Swap with down buffer" },
      { "<leader><leader>k", ss("swap_buf_up"), desc = "Swap with up buffer" },
      { "<leader><leader>l", ss("swap_buf_right"), desc = "Swap with right buffer" },
    },
  },
}
