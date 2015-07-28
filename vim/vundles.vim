" setup {{{1
"vim: fdm=marker fdl=0

let s:win_shell = (has('win32') || has('win64')) && &shellcmdflag =~ '/'
let s:vim_dir = s:win_shell ? '$HOME/vimfiles' : '$HOME/.vim'
let s:bundle_dir = s:vim_dir . '/bundle'

call plug#begin(s:bundle_dir)

" }}}

" File types {{{

Plug 'tpope/vim-liquid'
Plug 'tpope/vim-ragtag'
Plug 'groenewege/vim-less'
Plug 'aklt/plantuml-syntax'
Plug 'omailson/vim-qml'
Plug 'rygwdn/qmake-syntax-vim'
Plug 'rodjek/vim-puppet'
Plug 'plasticboy/vim-markdown'
Plug 'elzr/vim-json'
Plug 'derekwyatt/vim-scala'
Plug 'mustache/vim-mustache-handlebars'
Plug 'hynek/vim-python-pep8-indent', {'for': 'python'}

" Try to autodetect whitespace options
Plug 'tpope/vim-sleuth'

" Git syntax, etc.
Plug 'tpope/vim-git'

" Temporary (hopefully) to speed up yaml..
Plug 'stephpy/vim-yaml'

" OTL files
Plug 'vimoutliner/vimoutliner'

" For taking notes
Plug 'xolox/vim-notes'
Plug 'xolox/vim-misc'

" JS
Plug 'othree/javascript-libraries-syntax.vim', {'for': 'javascript'}
Plug 'dsawardekar/portkey', {'for': 'javascript'}
Plug 'dsawardekar/ember.vim', {'for': 'javascript'}

" sass/scss
Plug 'cakebaker/scss-syntax.vim'

" }}}

" Color schemes {{{

Plug 'candycode.vim'
Plug 'blackboard.vim'

" }}}

" Tags {{{

" THESE DO NOT PROVIDE PLUGINS. They provide bins
Plug 'jszakmeister/rst2ctags'
Plug 'jszakmeister/markdown2ctags'

" Note: requires phpctags to be build (run make)
Plug 'vim-php/tagbar-phpctags.vim', {'do': 'make'}

" }}}

" Heavy bundles {{{
if ! exists("g:light_bundles") || g:light_bundles == 0
    " Python-based bundles {{{
    if has("python")
        " Snippet engine
        Plug 'SirVer/ultisnips' | Plug 'honza/vim-snippets'

        " Extra functionality for python
        Plug 'davidhalter/jedi-vim', {'for': 'python'}
        Plug 'jmcantrell/vim-virtualenv', {'for': ['python', 'rst']}

        " OTF syntax checking
        if has("nvim")
            Plug 'benekastah/neomake'
        else
            Plug 'scrooloose/syntastic'
        endif

        if has("nvim")
            " Auto completion in C/C++/ObjC/Python
            Plug 'Valloric/YouCompleteMe', {'do': 'env TERM=dumb ./install.sh'}
        else
            Plug 'powerline/powerline', {'rtp': 'powerline/bindings/vim/'}
        endif

        " Restructured text in vim
        " Use winged's fork for now to get the neovim fix
        Plug 'winged/riv.vim' | Plug 'rykka/os.vim'
    endif
    " }}}

    " Unite all the things
    Plug 'Shougo/vimproc', {'do': 'make'}
    Plug 'Shougo/unite.vim' | Plug 'Shougo/unite-outline'

    " Lots of git functionality
    Plug 'tpope/vim-fugitive' | Plug 'int3/vim-extradite'

    " Easy management of signs
    Plug 'mhinz/vim-signify'

    " Mulitple cursors ala Sublime Text. Provides "Ctrl-N"
    Plug 'kristijanhusak/vim-multiple-cursors'

    " Nice incsearch
    Plug 'haya14busa/incsearch.vim'

    " Live markdown editing, requires `npm install -g livedown`
    Plug 'shime/vim-livedown', {'for': ['markdown', 'mkd']}
endif

" }}}


" General utils {{{

if index(keys(g:plugs), 'powerline') == -1
    " Nice status line..
    Plug 'bling/vim-airline'
endif

" Add :Pytest
Plug 'alfredodeza/pytest.vim', {'for': 'python'}

" Add surround commands
Plug 'tpope/vim-surround'

" Tabular
Plug 'godlygeek/tabular'

" Use "+" to grow selection
Plug 'terryma/vim-expand-region'

" Use M-{j,k} to move line/selection up/down
Plug 'matze/vim-move'

" Comment/uncomment. Provdes "gcc" (among others)
Plug 'tpope/vim-commentary'

" Provdes :BD
Plug 'moll/vim-bbye'

" Provides :Ack, :Ag
Plug 'mileszs/ack.vim'
Plug 'rking/ag.vim'

" Provides :Remove :Move, :Chmod, :Find, :Locate, :SudoWrite, :SudoEdit, :W
Plug 'tpope/vim-eunuch'

" I mostly use this for the ":S" command which is awesome
Plug 'tpope/vim-abolish', {'on': ['S', 'Subvert', 'Abolish']}

" Undo tree browser. :Gundo
Plug 'sjl/gundo.vim'

" Universal Text Linking (provide links between files..)
Plug 'utl.vim'

" File/dir tree. Provides "-"
Plug 'dhruvasagar/vim-vinegar'
Plug 'scrooloose/nerdtree'

" My own tag based fswitch.vim. Provides ,f{fhljk}
Plug 'rygwdn/tagswitch'

" Show tags in the current file in a tree
Plug 'majutsushi/tagbar'

" Add tmux-compatible C-{hjkl} mappings
Plug 'christoomey/vim-tmux-navigator'

if v:version >= 704
    " Auto switch between relative and non-relative depending on mode
    Plug 'myusuf3/numbers.vim'

    " Access remote stuff (e.g. :e ssh://me@soemplace/blah)
    Plug 'eiginn/netrw'
endif

" Allow certain things to be repeated
Plug 'tpope/vim-repeat'

" Allow opening files with /path/file:line:col
Plug 'kopischke/vim-fetch'

" Handle focus events from tmux
Plug 'tmux-plugins/vim-tmux-focus-events'

" }}}

call plug#end()
