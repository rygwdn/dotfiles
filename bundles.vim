set nocompatible               " be iMproved
filetype off                   " required!

set rtp+=~/.vim/lib/vundle
call vundle#rc()

" Deps
Bundle 'L9'

" Snippets
"Bundle "UltiSnips"
Bundle "rygwdn/ultisnips"

" Colorschemes
Bundle "candycode.vim"
Bundle "blackboard.vim"

" Programming
Bundle "tpope/vim-ragtag"
Bundle "DoxygenToolkit.vim"
Bundle "FSwitch"
Bundle "rygwdn/vim-ipython"
Bundle "rygwdn/vim-pylint"
Bundle "rygwdn/latexbox-rubber"

if has("python")
    Bundle "rygwdn/vim-async"
    Bundle "rygwdn/rope-omni"
python << EOF
import vim
try:
    import ropevim
except ImportError:
    vim.command('''au VimEnter * echomsg "can't import ropevim"''')
EOF
endif


" Filetypes
Bundle "LaTeX-Box"
Bundle "jQuery"
Bundle "pdc.vim"
Bundle "tpope/vim-rails"
Bundle "tpope/vim-cucumber"
Bundle "vim-ruby/vim-ruby"
Bundle "Rip-Rip/clang_complete"
Bundle "msanders/cocoa.vim"
Bundle "sukima/xmledit"
Bundle "vimoutliner/vimoutliner"
Bundle "nvie/vim-rst-tables"
Bundle "ingydotnet/yaml-vim"


" Search
Bundle "IndexedSearch"
Bundle "mileszs/ack.vim"
Bundle "gmarik/vim-visual-star-search"

" Open files
Bundle "scrooloose/nerdtree"

" Movement
Bundle "matchit.zip"
Bundle "kana/vim-operator-user"

" Navigation
Bundle "Marks-Browser"
Bundle "FuzzyFinder"
"Bundle "taglist.vim"
Bundle "ervandew/taglisttoo"

" Operations
Bundle "tpope/vim-repeat"
Bundle "tpope/vim-surround"
Bundle "michaeljsmith/vim-indent-object"

" Utility
Bundle "VOoM"
Bundle "ZoomWin"
Bundle "YankRing.vim"
Bundle "netrw.vim"
Bundle "tlib"
Bundle "bufkill.vim"
Bundle "CmdlineCompl.vim"
Bundle "tsaleh/vim-align"
Bundle "panozzaj/vim-autocorrect"
Bundle "gregsexton/VimCalc"
Bundle "session.vim--Odding"
Bundle "rygwdn/vim-conque"
Bundle "ervandew/supertab"
if v:version >= 703
    Bundle "sjl/gundo.vim"
endif

" Camelcase stuff
Bundle "camelcasemotion"
Bundle "operator-camelize"


" Git stuff
Bundle "tpope/vim-fugitive"
Bundle "tpope/vim-git"
Bundle "int3/vim-extradite"
Bundle "gitolite.vim"
