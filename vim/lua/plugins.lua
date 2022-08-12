-- auto install with
-- nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'

function firenvim()
  return not not vim.g['started_by_firenvim']
end

function vscode()
  return interactive() or vim.g['vscode']
end

function fish()
  return interactive() or os.getenv('VIM_FISH_BUNDLES')
end

function interactive()
  return not vim.g['started_by_firenvim'] and not vim.g['vscode'] and not os.getenv('VIM_FISH_BUNDLES')
end

function use_plugins(use)
  use 'wbthomason/packer.nvim'

  -- Load which-key unconditionally so that it's always available during plugin config
  use {
    "folke/which-key.nvim",
    config = function()
      if fish() then
        require("which-key").setup {
          -- your configuration comes here
          -- or leave it empty to use the default settings
          -- refer to the configuration section below
        }
      end
    end
  }

  use { 'glacambre/firenvim', run = function() vim.fn['firenvim#install'](0) end, cond = firenvim }

  use {'ggandor/leap.nvim',  cond = vscode, config = function()
    require('leap').set_default_keymaps()
  end}


  use {'tpope/vim-eunuch', cond = fish}
  use {'dag/vim-fish', cond = fish}
  use {'vim-scripts/candycode.vim', cond = fish}
  use {'tpope/vim-commentary', cond = fish}

  -- Plug 'aklt/plantuml-syntax'
  -- Plug 'vim-pandoc/vim-pandoc-syntax' 

  use {'PProvost/vim-ps1', cond = interactive}
  use {'tpope/vim-sleuth', cond = interactive}
  use {'tpope/vim-git', cond = interactive}

  -- TODO: use a better one?
  --Plug 'pangloss/vim-javascript', {'for': 'javascript'}
  --Plug 'othree/html5.vim', {'for': 'html'}

  use {'tpope/vim-fugitive', cond = interactive}

  -- TODO: use a better one?
  use {'bling/vim-airline', cond = interactive}

  use {'tpope/vim-surround', cond = interactive}
  use {'tpope/vim-repeat', cond = interactive}

  use {'vim-scripts/utl.vim', cond = interactive}
  use {'christoomey/vim-tmux-navigator', cond = interactive}
  use {'tmux-plugins/vim-tmux-focus-events', cond = interactive}
  use {'myusuf3/numbers.vim', cond = interactive}

  -- Allow opening files with /path/file:line:col
  use {'kopischke/vim-fetch', cond = interactive}


  -- vimwiki setup
  use {'vimwiki/vimwiki', cond = interactive}
  use {'tools-life/taskwiki', ft='vimwiki', cond = interactive}
  use {'powerman/vim-plugin-AnsiEsc', ft='vimwiki', cond = interactive}
  use {'farseer90718/vim-taskwarrior', ft='vimwiki', cond = interactive}

  use { 'nvim-treesitter/nvim-treesitter', run = ':TSUpdate', cond = interactive}

  use {'kyazdani42/nvim-web-devicons', cond = interactive, config = function()
    require'nvim-web-devicons'.setup { default = true; }
  end}

  use {'kyazdani42/nvim-tree.lua',
    cond = interactive,
    requires = {
      'folke/which-key.nvim',
    },
    config = function()
    require("nvim-tree").setup({
      hijack_netrw = true,
      hijack_directories = {enable = true},
      update_focused_file = {enable = true},
      filters = {
        dotfiles = true,
      },
      view = {
        mappings = {
          list = {
            {
              key = {"<CR>", "o"},
              action = "vinegar_in_place",
              action_cb = function(node)
                if vim.b.vinegar then
                  require("nvim-tree.api").node.open.replace_tree_buffer()
                else
                  require("nvim-tree.api").node.open.edit()
                end
              end,
            },
          }
        }
      }
    })

    require('which-key').register({
      t = {"<cmd>NvimTreeToggle<cr>", "Toggle Tree"}
    }, {prefix = "<leader>"})

    require('which-key').register({
      ["-"] = {
        function()
          local view = require"nvim-tree.view"
          if view.is_visible() then
            view.close()
          end
          require"nvim-tree".open_replacing_current_buffer()
          vim.b.vinegar = true
        end,
        "NvimTree in place",
      }
    })
  end}


  use
    {
      'nvim-telescope/telescope.nvim',
      cond = interactive,
      requires = {
        {'nvim-lua/popup.nvim', cond=interactive},
        'folke/which-key.nvim',
        {'nvim-lua/plenary.nvim', cond=interactive},
        {'nvim-telescope/telescope-ui-select.nvim', cond=interactive},
        {'nvim-telescope/telescope-symbols.nvim', cond=interactive},
        {'ElPiloto/telescope-vimwiki.nvim', cond=interactive},
        {'tami5/sqlite.lua', cond=interactive},
        {
          'nvim-telescope/telescope-frecency.nvim',
          cond = interactive,
          after = 'telescope.nvim',
          requires = {'tami5/sqlite.lua', cond=interactive},
        },
        {
          'nvim-telescope/telescope-fzf-native.nvim',
          run = 'make',
          cond = interactive,
        },
      },
      wants = {
        'popup.nvim',
        'plenary.nvim',
        'telescope-frecency.nvim',
        'telescope-fzf-native.nvim',
        'telescope-symbols.nvim',
        'telescope-vimwiki.nvim',
      },
      config = function () 
        require('telescope').load_extension('vimwiki')

        require('which-key').register({
          f = {
            name = "Telescope Find",
            f = {function() require('telescope.builtin').find_files() end, "Find Files"},
            g = {function() require('telescope.builtin').live_grep() end, "Grep Files"},
            b = {function() require('telescope.builtin').buffers() end, "Find Buffer"},
            h = {function() require('telescope.builtin').help_tags() end, "Find Help"},
          },
          v = {
            name = "Telescope Vimwiki",
            w = {function() require('telescope').extensions.vimwiki.vimwiki() end, "Find Wiki Page"},
            g = {function() require('telescope').extensions.vimwiki.live_grep() end, "Grep Wiki Pages"},
          },
        }, {prefix = "<leader>"})

        vim.api.nvim_create_autocmd('FileType', {
          pattern = 'vimwiki',
          group = 'vimrc',
          desc = 'Add vimwiki mappings',
          callback = function()
            vim.keymap.set('i', '[[[', '<cmd>Telescope vimwiki link<cr>', {desc='Insert vimwiki link', buffer=true})
            vim.keymap.set('i', '::', function() require('telescope.builtin').symbols({sources={'emoji'}}) end, {desc='Insert emoji', buffer=true})
          end
        })
      end,
    }
end

-- Recompile when this file changes
vim.cmd([[
  augroup packer_user_config
    autocmd!
    autocmd BufWritePost plugins.lua source <afile> | PackerCompile
  augroup end
]])

local install_path = vim.fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
if vim.fn.empty(vim.fn.glob(install_path)) > 0 then
  packer_bootstrap = vim.fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
end

vim.cmd [[packadd packer.nvim]]

return require('packer').startup(function(use)
  use_plugins(use)

  -- Automatically set up your configuration after cloning packer.nvim
  -- Put this at the end after all plugins
  if packer_bootstrap then
    require('packer').sync()
  end
end)
