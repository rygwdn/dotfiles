-- Enhanced Deno detection: deno.json, shebang, or Deno.* API usage

-- Helper: detect if buffer is a Deno file
local function is_deno_buffer(bufnr)
  -- Check for deno.json/deno.jsonc in project
  if vim.fs.root(bufnr, { "deno.json", "deno.jsonc" }) then
    return true
  end

  -- Check shebang for deno
  local first_line = vim.api.nvim_buf_get_lines(bufnr, 0, 1, false)[1] or ""
  if first_line:match("^#!.*deno") then
    return true
  end

  -- Check first 30 lines for Deno.* usage
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, 30, false)
  for _, line in ipairs(lines) do
    if line:match("Deno%.") then
      return true
    end
  end

  return false
end

return {
  {
    "neovim/nvim-lspconfig",
    opts = function(_, opts)
      -- Ensure servers table exists
      opts.servers = opts.servers or {}

      -- Configure denols with enhanced detection
      opts.servers.denols = vim.tbl_deep_extend("force", opts.servers.denols or {}, {
        root_dir = function(bufnr, on_dir)
          if not is_deno_buffer(bufnr) then
            return -- don't attach
          end
          -- Use deno.json root, or file's directory for single-file scripts
          local root = vim.fs.root(bufnr, { "deno.json", "deno.jsonc" })
            or vim.fn.fnamemodify(vim.api.nvim_buf_get_name(bufnr), ":h")
          on_dir(root)
        end,
        settings = {
          deno = {
            enable = true,
            lint = true,
            suggest = {
              imports = {
                hosts = {
                  ["https://deno.land"] = true,
                  ["https://jsr.io"] = true,
                },
              },
            },
          },
        },
      })

      -- Prevent vtsls from attaching to Deno buffers
      opts.servers.vtsls = vim.tbl_deep_extend("force", opts.servers.vtsls or {}, {
        root_dir = function(bufnr, on_dir)
          if is_deno_buffer(bufnr) then
            return -- don't attach to Deno files
          end
          -- Fall back to LazyVim's default behavior
          local markers = vim.lsp.config.vtsls and vim.lsp.config.vtsls.root_markers
          if markers and type(markers) == "table" then
            local root = vim.fs.root(bufnr, markers)
            if root then
              on_dir(root)
            end
          end
        end,
      })

      return opts
    end,
  },
}
