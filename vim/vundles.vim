" setup {{{1

set nocompatible               " be iMproved
filetype off                   " required!

let s:win_shell = (has('win32') || has('win64')) && &shellcmdflag =~ '/'
let s:bundle_dir = s:win_shell ? '$HOME/vimfiles/bundle' : '$HOME/.vim/bundle'
let &runtimepath .= ',' . expand(s:bundle_dir . '/Vundle.vim')

call vundle#begin(s:bundle_dir)

" let Vundle manage Vundle, required
Plugin 'gmarik/Vundle.vim'

" }}}

" File types {{{

Plugin 'tpope/vim-liquid'
Plugin 'tpope/vim-ragtag'
Plugin 'groenewege/vim-less'
Plugin 'aklt/plantuml-syntax'
Plugin 'nono/vim-handlebars'
Plugin 'omailson/vim-qml'
Plugin 'rygwdn/qmake-syntax-vim'
Plugin 'rodjek/vim-puppet'
Plugin 'plasticboy/vim-markdown'

" Try to autodetect whitespace options
Plugin 'tpope/vim-sleuth'

" Restructured text in vim
Plugin 'Rykka/riv.vim'

" Git syntax, etc.
Plugin 'tpope/vim-git'

" Temporary (hopefully) to speed up yaml..
Plugin 'stephpy/vim-yaml'

" OTL files
Plugin 'vimoutliner/vimoutliner'

" For taking notes
Plugin 'xolox/vim-notes'
Plugin 'xolox/vim-misc'

" }}}

" Color schemes {{{

Plugin 'candycode.vim'
Plugin 'blackboard.vim'

" }}}

" Tags {{{

" THESE DO NOT PROVIDE PLUGINS. They provide bins
Plugin 'jszakmeister/rst2ctags'
Plugin 'jszakmeister/markdown2ctags'

" Note: requires phpctags to be build (run make)
Plugin 'vim-php/tagbar-phpctags.vim'

" }}}

if ! exists("g:light_bundles") || g:light_bundles == 0
    if has("python")
        " Snippet engine
        Plugin 'SirVer/ultisnips'
        " Snippets
        Plugin 'honza/vim-snippets'

        " Auto completion in C/C++/ObjC/Python
        Plugin 'Valloric/YouCompleteMe'

        " Extra functionality for python
        Plugin 'davidhalter/jedi-vim'

        " OTF syntax checking
        Plugin 'scrooloose/syntastic'
    endif

    " Unite all the things
    Plugin 'Shougo/unite.vim'
    Plugin 'Shougo/vimproc'
    Plugin 'Shougo/unite-outline'

    " JS Completion with nodejs
    " Plugin 'marijnh/tern_for_vim'

    " Lots of git functionality
    Plugin 'tpope/vim-fugitive'

    " Easy management of signs
    Plugin 'mhinz/vim-signify'

    " Automatic sessions
    Plugin 'session.vim--Odding'

    " Mulitple cursors ala Sublime Text. Provides "Ctrl-N"
    Plugin 'terryma/vim-multiple-cursors'
endif

" Nice status line..
Plugin 'bling/vim-airline'

" Add surround commands
Plugin 'tpope/vim-surround'

" Tabular
Plugin 'godlygeek/tabular'

" Use "+" to grow selection
Plugin 'terryma/vim-expand-region'

" Use M-{j,k} to move line/selection up/down
Plugin 'matze/vim-move'

" Comment/uncomment. Provdes "gcc" (among others)
Plugin 'tpope/vim-commentary'

" Provdes :BD
Plugin 'moll/vim-bbye'

" Provides :Ack, :Ag
Plugin 'mileszs/ack.vim'
Plugin 'rking/ag.vim'

" Provides :Remove :Move, :Chmod, :Find, :Locate, :SudoWrite, :SudoEdit, :W
Plugin 'tpope/vim-eunuch'

" I mostly use this for the ":S" command which is awesome
Plugin 'tpope/vim-abolish'

" Undo tree browser. :Gundo
Plugin 'sjl/gundo.vim'

" Access remote stuff (e.g. :e ssh://me@soemplace/blah)
Plugin 'netrw.vim'

" Universal Text Linking (provide links between files..)
Plugin 'utl.vim'

" File/dir tree. Provides "-"
Plugin 'tpope/vim-vinegar'

" My own tag based fswitch.vim. Provides ,f{fhljk}
Plugin 'rygwdn/tagswitch'

" Show tags in the current file in a tree
Plugin 'majutsushi/tagbar'

" Add tmux-compatible C-{hjkl} mappings
Plugin 'christoomey/vim-tmux-navigator'

if v:version >= 704
    " Auto switch between relative and non-relative depending on mode
    Plugin 'myusuf3/numbers.vim'
endif

" Awesome file finding. Provies Ctrl-P and <Space>
"Plugin 'kien/ctrlp.vim'

" Allow certain things to be repeated
Plugin 'tpope/vim-repeat'

" Manual plugins
Plugin 'snips', {'name': '../pre/snips', 'pinned': 1}
Plugin 'voom_cust', {'name': '../pre/voom_cust', 'pinned': 1}

call vundle#end()

"vim: fdm=marker fdl=0
