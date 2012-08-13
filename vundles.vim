set nocompatible               " be iMproved
filetype off                   " required!

if has("win32") || has("win64")
    set rtp+=~/vimfiles/lib/vundle
    call vundle#rc("~/vimfiles/bundle")
else
    set rtp+=~/.vim/lib/vundle
    call vundle#rc()
endif

" Deps
Bundle 'L9'
Bundle "netrw.vim"
Bundle "tlib"
Bundle "utl.vim"
"if has("python")
"    Bundle "rygwdn/vim-async"
"endif

" Snippets
Bundle "SirVer/ultisnips"

" Colorschemes
Bundle "candycode.vim"
Bundle "blackboard.vim"
Bundle "kien/rainbow_parentheses.vim"

" Web dev
"Bundle "mephux/vim-javascript.git"
"Bundle "jQuery"

" Docs
"Bundle "rygwdn/latexbox-rubber"

" Python
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



" General
Bundle "vimoutliner/vimoutliner"
Bundle "mileszs/ack.vim"
Bundle "bufkill.vim"
Bundle "derekwyatt/vim-fswitch"
if has("python")
    Bundle "VOoM"
endif


" Navigation
Bundle "scrooloose/nerdtree"
Bundle "majutsushi/tagbar"

" Operations
Bundle "michaeljsmith/vim-indent-object"
Bundle "camelcasemotion"

" Utility
Bundle "session.vim--Odding"
Bundle "ervandew/supertab"
Bundle "kien/ctrlp.vim"
if v:version >= 703
    Bundle "sjl/gundo.vim"
endif
"Bundle "rygwdn/vim-conque"


" Git stuff
Bundle "tpope/vim-fugitive"
Bundle "tpope/vim-git"
Bundle "int3/vim-extradite"
"Bundle "gitolite.vim"
