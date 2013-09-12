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

" Access remote stuff (e.g. :e ssh://me@soemplace/blah)
Bundle "netrw.vim"
" Universal Text Linking (provide links between files..)
Bundle "utl.vim"

" Smart tab completion
Bundle "ervandew/supertab"

if has("python")
    " Snippets
    Bundle "SirVer/ultisnips"
    " Nice outlining of files
    Bundle "VOoM"
    " Auto completion in C/C++/ObjC/Python
    Bundle "Valloric/YouCompleteMe"
endif

" Auto switch between relative and non-relative depending on mode
Bundle "myusuf3/numbers.vim"

" Color schemes I use..
Bundle "candycode.vim"
Bundle "blackboard.vim"

Bundle "nono/vim-handlebars"

" Syntax highlighting for QML
Bundle "omailson/vim-qml"
Bundle "rygwdn/qmake-syntax-vim"

" OTL files
Bundle "vimoutliner/vimoutliner"

" Use Ack from vim..
Bundle "mileszs/ack.vim"

" Kill buffers without closing splits/tabs
Bundle "moll/vim-bbye"

" My own tag based fswitch.vim
Bundle "rygwdn/tagswitch"

" I mostly use this for the ":S" command which is awesome
Bundle "tpope/vim-abolish"

" File/dir tree
Bundle "scrooloose/nerdtree"

" Show tags in the current file in a tree
Bundle "majutsushi/tagbar"

" Automatic sessions
Bundle "session.vim--Odding"

" Awesome file finding
Bundle "kien/ctrlp.vim"

" Unto tree browser
Bundle "sjl/gundo.vim"

" Replaced by installation through pip
"Bundle "Lokaltog/vim-powerline"

" Use "+" to grow selection
Bundle "terryma/vim-expand-region"

" Use M-{j,k} to move line/selection up/down
Bundle "matze/vim-move"

" Restructured text in vim
Bundle "Rykka/riv.vim"

" For taking notes
Bundle "xolox/vim-notes"
Bundle "xolox/vim-misc"

" Git syntax, etc.
Bundle "tpope/vim-git"

" Lots of git functionality
Bundle "tpope/vim-fugitive"

" Easy management of signs
Bundle "mhinz/vim-signify"

" Mulitple cursors ala Sublime Text
Bundle "terryma/vim-multiple-cursors"

" Comment/uncomment
Bundle "tpope/vim-commentary"

" Allow certain things to be repeated
Bundle "tpope/vim-repeat"

" Autoinstall if the bundle dir is not present
if glob(s:bundle_dir) == ""
    au VimEnter * BundleInstall
endif

"vim: fdm=marker fdl=0
