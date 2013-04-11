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

" Deps {{{1
Bundle 'L9'
Bundle "netrw.vim"
Bundle "tlib"
Bundle "utl.vim"
"if has("python")
"    Bundle "rygwdn/vim-async"
"endif

" Snippets {{{1
Bundle "ervandew/supertab"
if has("python")
    Bundle "SirVer/ultisnips"
endif

" Colorschemes {{{1
Bundle "candycode.vim"
Bundle "blackboard.vim"
Bundle "kien/rainbow_parentheses.vim"

" Web dev {{{1
"Bundle "mephux/vim-javascript.git"
"Bundle "jQuery"

" Docs {{{1
"Bundle "rygwdn/latexbox-rubber"

" Python {{{1
"Bundle "rygwdn/vim-pylint"
"if has("python")
"    Bundle "rygwdn/rope-omni"
"python << EOF
"import vim
"try:
"    import ropevim
"except ImportError:
"    vim.command('''au VimEnter * echomsg "can't import ropevim"''')
"EOF
"endif

" QML {{{1
Bundle "omailson/vim-qml"


" General {{{1
Bundle "vimoutliner/vimoutliner"
Bundle "mileszs/ack.vim"
Bundle "bufkill.vim"
"Bundle "derekwyatt/vim-fswitch"
Bundle "rygwdn/tagswitch"
if has("python")
    Bundle "VOoM"
endif


" org mode {{{1
"Bundle "jceb/vim-orgmode"
"Bundle "utl.vim"
"Bundle "tpope/vim-repeat"
"Bundle "tpope/vim-speeddating"
"Bundle "chrisbra/NrrwRgn"
"Bundle "calendar.vim"


" Navigation {{{1
Bundle "scrooloose/nerdtree"
Bundle "majutsushi/tagbar"

" Operations {{{1
Bundle "michaeljsmith/vim-indent-object"
Bundle "camelcasemotion"

" Utility {{{1
Bundle "session.vim--Odding"
Bundle "kien/ctrlp.vim"
if v:version >= 703
    Bundle "sjl/gundo.vim"
endif
if has("gui_running")
    Bundle "Lokaltog/vim-powerline"
endif
"Bundle "rygwdn/vim-conque"


" Git stuff {{{1
Bundle "tpope/vim-fugitive"
Bundle "tpope/vim-git"
Bundle "int3/vim-extradite"
Bundle "sjl/splice.vim"
"Bundle 'airblade/vim-gitgutter'
"Bundle "gitolite.vim"

if glob(s:bundle_dir) == ""
    au VimEnter * BundleInstall
endif

"vim: fdm=marker fdl=0
