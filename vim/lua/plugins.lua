-- auto install with
-- nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'
local fn = vim.fn

function use_plugins(use)
  if vim.g['started_by_firenvim'] then
    use { 'glacambre/firenvim', run = function() vim.fn['firenvim#install'](0) end }
    return
  end

  if vim.g['vscode'] then
    return
  end

  use {
    "folke/which-key.nvim",
    config = function()
      require("which-key").setup {
        -- your configuration comes here
        -- or leave it empty to use the default settings
        -- refer to the configuration section below
      }
    end
  }

  use 'wbthomason/packer.nvim'
  use 'tpope/vim-eunuch'
  use 'dag/vim-fish'
  use 'vim-scripts/candycode.vim'
  use 'tpope/vim-commentary'

  if os.getenv('VIM_FISH_BUNDLES') then
    -- That's all we load for fish
    return
  end

  -- Plug 'aklt/plantuml-syntax'
  -- Plug 'vim-pandoc/vim-pandoc-syntax' 

  use 'PProvost/vim-ps1'
  use 'tpope/vim-sleuth'
  use 'tpope/vim-git'

  -- TODO: use a better one?
  --Plug 'pangloss/vim-javascript', {'for': 'javascript'}
  --Plug 'othree/html5.vim', {'for': 'html'}

  use 'tpope/vim-fugitive'

  -- TODO: use a better one?
  use 'bling/vim-airline'

  use 'tpope/vim-surround'
  use 'tpope/vim-repeat'

  use 'vim-scripts/utl.vim'
  use 'christoomey/vim-tmux-navigator'
  use 'tmux-plugins/vim-tmux-focus-events'
  use 'myusuf3/numbers.vim'

  -- Allow opening files with /path/file:line:col
  use 'kopischke/vim-fetch'


  -- vimwiki setup
  use 'vimwiki/vimwiki'
  use 'tools-life/taskwiki'
  use 'powerman/vim-plugin-AnsiEsc'
  use 'farseer90718/vim-taskwarrior'

  use { 'nvim-treesitter/nvim-treesitter', run = ':TSUpdate' }

  use {'kyazdani42/nvim-web-devicons', config = function()
    require'nvim-web-devicons'.setup { default = true; }
  end}

  use {'ggandor/leap.nvim', config = function()
    require('leap').set_default_keymaps()
  end}

  use {'kyazdani42/nvim-tree.lua', config = function()
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
      requires = {
        'nvim-lua/popup.nvim',
        'nvim-lua/plenary.nvim',
        'nvim-telescope/telescope-ui-select.nvim',
        'nvim-telescope/telescope-symbols.nvim',
        'ElPiloto/telescope-vimwiki.nvim',
        {
          'nvim-telescope/telescope-frecency.nvim',
          after = 'telescope.nvim',
          requires = 'tami5/sqlite.lua',
        },
        {
          'nvim-telescope/telescope-fzf-native.nvim',
          run = 'make',
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

local install_path = fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
if fn.empty(fn.glob(install_path)) > 0 then
  packer_bootstrap = fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
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
