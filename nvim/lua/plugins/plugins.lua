return {
  { "nvim-mini/mini.pairs", enabled = false },
  {
    "windwp/nvim-autopairs",
    enabled = false,
    event = "InsertEnter",
    config = true,
    opts = {
      disable_in_visualblock = true,
    },
  },

  {
    "stevearc/conform.nvim",
    opts = function(_, opts)
      opts.format_on_save = nil
    end,
  },

  -- {
  --   "pwntester/octo.nvim",
  --   requires = {
  --     "nvim-lua/plenary.nvim",
  --     "folke/snacks.nvim",
  --     "nvim-tree/nvim-web-devicons",
  --   },
  --   opts = function(_, opts)
  --     opts.picker = "snacks"
  --   end,
  -- },
  {
    "coder/claudecode.nvim",
    opts = {
      log_level = "debug",
      terminal_cmd = "/opt/homebrew/bin/claude --debug",
      terminal = {
        provider = (function()
          -- State captured in closure
          local state = {
            pane_id = nil,
            config = nil,
            nvim_pane_id = nil,
          }

          -- Helper: check if pane exists
          local function pane_exists()
            if not state.pane_id then
              return false
            end
            local output = vim.fn.system("wezterm cli list --format json")
            if vim.v.shell_error ~= 0 then
              return false
            end
            local ok, panes = pcall(vim.fn.json_decode, output)
            if not ok then
              return false
            end
            for _, pane in ipairs(panes) do
              if pane.pane_id == state.pane_id then
                return true
              end
            end
            return false
          end

          -- Helper: check if pane is focused
          local function is_pane_focused()
            if not state.pane_id then
              return false
            end
            local output = vim.fn.system("wezterm cli list --format json")
            if vim.v.shell_error ~= 0 then
              return false
            end
            local ok, panes = pcall(vim.fn.json_decode, output)
            if not ok then
              return false
            end
            for _, pane in ipairs(panes) do
              if pane.pane_id == state.pane_id then
                return pane.is_active == true
              end
            end
            return false
          end

          local function log(msg)
            vim.notify("[wezterm-provider] " .. msg, vim.log.levels.INFO)
          end

          -- Helper: open pane
          local function open_pane(cmd_string, env_table, effective_config, focus)
            log("open_pane called")
            log("cmd_string: " .. vim.inspect(cmd_string))
            log("env_table: " .. vim.inspect(env_table))
            log("focus: " .. tostring(focus))

            -- If pane exists and is valid, just focus it if requested
            if pane_exists() then
              log("pane already exists, focusing")
              if focus then
                vim.fn.system("wezterm cli activate-pane --pane-id " .. state.pane_id)
              end
              return
            end

            -- Build env string for the command
            local env_parts = {}
            for key, value in pairs(env_table or {}) do
              table.insert(env_parts, key .. "=" .. vim.fn.shellescape(value))
            end

            -- Wrap command with sleep to allow websocket server to start
            local wrapped_cmd = "bash -c 'sleep 0.5 && " .. cmd_string:gsub("'", "'\\''") .. " --ide'"

            local cmd
            if false then -- #env_parts > 0 then
              cmd = "wezterm cli split-pane --right -- env " .. table.concat(env_parts, " ") .. " " .. wrapped_cmd
            else
              cmd = "wezterm cli split-pane --right -- " .. wrapped_cmd
            end

            log("executing: " .. cmd)

            -- Run split-pane and capture pane ID from stdout
            local output = vim.fn.system(cmd)
            log("output: " .. vim.inspect(output))
            log("shell_error: " .. tostring(vim.v.shell_error))

            if vim.v.shell_error == 0 then
              state.pane_id = tonumber(vim.trim(output))
              log("captured pane_id: " .. tostring(state.pane_id))
            else
              log("ERROR: split-pane failed")
            end

            -- If focus=false, return to nvim pane
            if not focus and state.nvim_pane_id then
              vim.fn.system("wezterm cli activate-pane --pane-id " .. state.nvim_pane_id)
            end
          end

          -- Helper: close pane
          local function close_pane()
            if state.pane_id and pane_exists() then
              vim.fn.system("wezterm cli kill-pane --pane-id " .. state.pane_id)
            end
            state.pane_id = nil
          end

          local function toggle(cmd_string, env_table, effective_config)
            if pane_exists() then
              if is_pane_focused() then
                if state.nvim_pane_id then
                  vim.fn.system("wezterm cli activate-pane --pane-id " .. state.nvim_pane_id)
                end
              else
                vim.fn.system("wezterm cli activate-pane --pane-id " .. state.pane_id)
              end
            else
              open_pane(cmd_string, env_table, effective_config, true)
            end
          end

          return {
            setup = function(config)
              state.config = config
              state.nvim_pane_id = tonumber(vim.env.WEZTERM_PANE)
            end,

            open = function(cmd_string, env_table, effective_config, focus)
              open_pane(cmd_string, env_table, effective_config, focus)
            end,

            close = function()
              close_pane()
            end,

            simple_toggle = function(cmd_string, env_table, effective_config)
              toggle(cmd_string, env_table, effective_config)
            end,

            focus_toggle = function(cmd_string, env_table, effective_config)
              toggle(cmd_string, env_table, effective_config)
            end,

            get_active_bufnr = function()
              return nil
            end,

            is_available = function()
              return vim.fn.executable("wezterm") == 1 and vim.env.WEZTERM_PANE
            end,
          }
        end)(),
      },
    },
  },
  {
    "tpope/vim-eunuch",
    vscode = true,
    cmd = {
      "Remove",
      "Delete",
      "Move",
      "Chmod",
      "Mkdir",
      "Cfind",
      "Clocate",
      "Lfind",
      "Llocalte",
      "Wall",
      "SudoWrite",
      "SudoEdit",
    },
  },
  {
    "tpope/vim-fugitive",
    cmd = {
      "Git",
      "Gedit",
      "Gsplit",
      "Gdiffsplit",
      "Gvdiffsplit",
      "Gread",
      "Gwrite",
      "Ggrep",
      "GMove",
      "GDelete",
      "GBrowse",
    },
  },

  {
    "folke/tokyonight.nvim",
    opts = {
      dim_inactive = true, -- dims inactive windows
      on_colors = function(c)
        c.border = c.blue0
        c.bg_dark = c.black
      end,
    },
  },

  {
    "folke/flash.nvim",
    opts = {
      modes = {
        char = {
          keys = { "f", "F", "t", "T", ";", [","] = "\\" },
        },
      },
    },
  },

  {
    "stevearc/oil.nvim",
    opts = {},
    dependencies = { "nvim-tree/nvim-web-devicons" },
    keys = {
      {
        "-",
        function()
          require("oil").open()
        end,
        desc = "Open parent directory",
      },
    },
  },
}
