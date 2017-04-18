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
"Plug 'plasticboy/vim-markdown'
Plug 'elzr/vim-json'
Plug 'derekwyatt/vim-scala'
Plug 'mustache/vim-mustache-handlebars'
Plug 'hynek/vim-python-pep8-indent', {'for': 'python'}
Plug 'vim-pandoc/vim-pandoc-syntax' 

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
Plug 'kchmck/vim-coffee-script'
Plug 'pangloss/vim-javascript'
Plug 'othree/javascript-libraries-syntax.vim', {'for': 'javascript'}
Plug 'dsawardekar/portkey', {'for': 'javascript'}
Plug 'dsawardekar/ember.vim', {'for': 'javascript'}
Plug 'matthewsimo/angular-vim-snippets', {'for': ['javascript', 'html']}
Plug 'burnettk/vim-angular', {'for': ['javascript', 'html']}
Plug 'mattn/emmet-vim', {'for': 'html'}
Plug 'othree/html5.vim', {'for': 'html'}

" sass/scss
Plug 'cakebaker/scss-syntax.vim'

" }}}

" Color schemes {{{

Plug 'candycode.vim'
Plug 'blackboard.vim'
Plug 'chriskempson/base16-vim'

" }}}

" Tags {{{

" THESE DO NOT PROVIDE PLUGINS. They provide bins
Plug 'jszakmeister/rst2ctags'
Plug 'jszakmeister/markdown2ctags'

" Note: requires phpctags to be build (run make)
"Plug 'vim-php/tagbar-phpctags.vim', {'do': 'make'}

" }}}

" Heavy bundles {{{

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
" Plug 'sjl/gundo.vim'
"
" Fork of Gundo
Plug 'simnalamburt/vim-mundo'

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
