" setup {{{1

set nocompatible               " be iMproved
filetype off                   " required!

let s:bundle_dir=expand("~/.vim/bundle")
if has("win32") || has("win64")
    set rtp+=~/vimfiles/lib/vundle
    call vundle#rc("~/vimfiles/bundle")
    let s:bundle_dir=expand("~/vimfiles/bundle")
else
    set rtp+=~/.vim/lib/vundle
    call vundle#rc()
endif

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

if ! exists("g:light_bundles") || g:light_bundles == 0
    if has("python")
        " Snippet engine
        Plugin 'SirVer/ultisnips'
        " Snippets
        Plugin 'honza/vim-snippets'

        " Auto completion in C/C++/ObjC/Python
        Plugin 'Valloric/YouCompleteMe'

        " OTF syntax checking
        Plugin 'scrooloose/syntastic'
    endif

    " Lots of git functionality
    Plugin 'tpope/vim-fugitive'

    " Easy management of signs
    Plugin 'mhinz/vim-signify'

    " Automatic sessions
    Plugin 'session.vim--Odding'

    " Mulitple cursors ala Sublime Text. Provides "Ctrl-N"
    Plugin 'terryma/vim-multiple-cursors'
endif

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

" Provides :Ack
Plugin 'mileszs/ack.vim'

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

if v:version >= 704
    " Auto switch between relative and non-relative depending on mode
    Plugin 'myusuf3/numbers.vim'
endif

" Awesome file finding. Provies Ctrl-P and <Space>
Plugin 'kien/ctrlp.vim'

" Allow certain things to be repeated
Plugin 'tpope/vim-repeat'

" Autoinstall if the bundle dir is not present
if glob(s:bundle_dir) == ""
    au VimEnter * BundleInstall
endif

"vim: fdm=marker fdl=0
