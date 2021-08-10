let s:win_shell = (has('win32') || has('win64')) && &shellcmdflag =~ '/'
let s:vim_dir = s:win_shell ? '$HOME/vimfiles' : '$HOME/.vim'
let s:bundle_dir = s:vim_dir . '/bundle'

call plug#begin(s:bundle_dir)

Plug 'godlygeek/tabular'
Plug 'moll/vim-bbye'
Plug 'tpope/vim-eunuch'
Plug 'tpope/vim-abolish', {'on': ['S', 'Subvert', 'Abolish']}
Plug 'simnalamburt/vim-mundo'


if !exists('g:vscode')
    Plug 'dag/vim-fish'
    Plug 'vim-scripts/candycode.vim'
    Plug 'tpope/vim-commentary'

    if $VIM_FISH_BUNDLES != 1
        Plug 'tpope/vim-liquid'
        Plug 'tpope/vim-ragtag'
        Plug 'groenewege/vim-less'
        Plug 'aklt/plantuml-syntax'
        Plug 'elzr/vim-json'
        Plug 'mustache/vim-mustache-handlebars'
        Plug 'hynek/vim-python-pep8-indent', {'for': 'python'}
        Plug 'vim-pandoc/vim-pandoc-syntax' 
        Plug 'dag/vim-fish'
        Plug 'PProvost/vim-ps1'

        Plug 'tpope/vim-sleuth'

        Plug 'tpope/vim-git'


        Plug 'pangloss/vim-javascript', {'for': 'javascript'}
        Plug 'othree/javascript-libraries-syntax.vim', {'for': 'javascript'}
        Plug 'dsawardekar/portkey', {'for': 'javascript'}
        Plug 'othree/html5.vim', {'for': 'html'}

        Plug 'cakebaker/scss-syntax.vim'
        Plug 'tridactyl/vim-tridactyl'


        Plug 'vim-scripts/candycode.vim'

        Plug 'tpope/vim-fugitive'

        if index(keys(g:plugs), 'powerline') == -1
            " Nice status line..
            Plug 'bling/vim-airline'
        endif

        " Add surround commands
        Plug 'tpope/vim-surround'

        " Comment/uncomment. Provdes "gcc" (among others)
        Plug 'tpope/vim-commentary'

        " Universal Text Linking (provide links between files..)
        Plug 'vim-scripts/utl.vim'

        " File/dir tree. Provides "-"
        Plug 'dhruvasagar/vim-vinegar'

        " Add tmux-compatible C-{hjkl} mappings
        Plug 'christoomey/vim-tmux-navigator'

        if v:version >= 704
            " Auto switch between relative and non-relative depending on mode
            Plug 'myusuf3/numbers.vim'
        endif

        " Allow certain things to be repeated
        Plug 'tpope/vim-repeat'

        " Allow opening files with /path/file:line:col
        Plug 'kopischke/vim-fetch'

        " Handle focus events from tmux
        Plug 'tmux-plugins/vim-tmux-focus-events'

        Plug 'glacambre/firenvim', { 'do': { _ -> firenvim#install(0) } }
    endif
endif

call plug#end()
