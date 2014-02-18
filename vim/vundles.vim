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

Bundle "tpope/vim-liquid"
Bundle "tpope/vim-ragtag"
Bundle 'groenewege/vim-less'
Bundle "aklt/plantuml-syntax"
Bundle "nono/vim-handlebars"
Bundle "omailson/vim-qml"
Bundle "rygwdn/qmake-syntax-vim"
Bundle "rodjek/vim-puppet"

" Restructured text in vim
Bundle "Rykka/riv.vim"

" Git syntax, etc.
Bundle "tpope/vim-git"

" Temporary (hopefully) to speed up yaml..
Bundle "stephpy/vim-yaml"

" OTL files
Bundle "vimoutliner/vimoutliner"

" For taking notes
Bundle "xolox/vim-notes"
Bundle "xolox/vim-misc"

" }}}

" Color schemes {{{

Bundle "candycode.vim"
Bundle "blackboard.vim"

" }}}

if has("python")
    " Snippets
    Bundle "SirVer/ultisnips"

    " Auto completion in C/C++/ObjC/Python
    Bundle "Valloric/YouCompleteMe"
endif

" Add surround commands
Bundle "tpope/vim-surround"

" Tabular
Bundle "godlygeek/tabular"

" Use "+" to grow selection
Bundle "terryma/vim-expand-region"

" Use M-{j,k} to move line/selection up/down
Bundle "matze/vim-move"

" Mulitple cursors ala Sublime Text. Provides "Ctrl-N"
Bundle "terryma/vim-multiple-cursors"

" Comment/uncomment. Provdes "gcc" (among others)
Bundle "tpope/vim-commentary"

" Provdes :BD
Bundle "moll/vim-bbye"

" Provides :Ack
Bundle "mileszs/ack.vim"

" I mostly use this for the ":S" command which is awesome
Bundle "tpope/vim-abolish"

" Undo tree browser. :Gundo
Bundle "sjl/gundo.vim"

" Access remote stuff (e.g. :e ssh://me@soemplace/blah)
Bundle "netrw.vim"

" Universal Text Linking (provide links between files..)
Bundle "utl.vim"

" File/dir tree. Provides "-"
Bundle "tpope/vim-vinegar"

" My own tag based fswitch.vim. Provides ,f{fhljk}
Bundle "rygwdn/tagswitch"

" Show tags in the current file in a tree
Bundle "majutsushi/tagbar"

" Automatic sessions
Bundle "session.vim--Odding"
if v:version >= 704
    " Auto switch between relative and non-relative depending on mode
    Bundle "myusuf3/numbers.vim"
endif

" Awesome file finding. Provies Ctrl-P and <Space>
Bundle "kien/ctrlp.vim"

" Lots of git functionality
Bundle "tpope/vim-fugitive"

" Easy management of signs
Bundle "mhinz/vim-signify"

" Allow certain things to be repeated
Bundle "tpope/vim-repeat"

" Autoinstall if the bundle dir is not present
if glob(s:bundle_dir) == ""
    au VimEnter * BundleInstall
endif

"vim: fdm=marker fdl=0
