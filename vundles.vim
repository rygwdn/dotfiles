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

" Snippets
"Bundle "UltiSnips"
Bundle "SirVer/ultisnips"

" Colorschemes
Bundle "candycode.vim"
Bundle "blackboard.vim"

" Programming
"Bundle "tpope/vim-ragtag"
"Bundle "DoxygenToolkit.vim"
"Bundle "FSwitch"
"Bundle "rygwdn/vim-ipython"
Bundle "rygwdn/vim-pylint"
Bundle "rygwdn/latexbox-rubber"
Bundle "mephux/vim-javascript.git"
"Bundle "Twinside/vim-codeoverview"

if has("python")
    Bundle "VOoM"
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
"Bundle "LaTeX-Box"
Bundle "jQuery"
"Bundle "pdc.vim"
"Bundle "tpope/vim-rails"
"Bundle "tpope/vim-cucumber"
"Bundle "vim-ruby/vim-ruby"
"Bundle "Rip-Rip/clang_complete"
"Bundle "msanders/cocoa.vim"
"Bundle "sukima/xmledit"
Bundle "vimoutliner/vimoutliner"
"Bundle "nvie/vim-rst-tables"
Bundle "ingydotnet/yaml-vim"
Bundle "jceb/vim-orgmode"
Bundle "utl.vim"

" Search
"Bundle "IndexedSearch"
Bundle "mileszs/ack.vim"
"Bundle "gmarik/vim-visual-star-search"

" Open files
Bundle "scrooloose/nerdtree"

" Movement
Bundle "matchit.zip"
"Bundle "kana/vim-operator-user"

" Navigation
"Bundle "Marks-Browser"
"Bundle "FuzzyFinder"
"Bundle "taglist.vim"
Bundle "ervandew/taglisttoo"
Bundle "majutsushi/tagbar"

" Operations
Bundle "tpope/vim-repeat"
Bundle "tpope/vim-surround"
Bundle "michaeljsmith/vim-indent-object"
Bundle "tpope/vim-speeddating"

" Utility
"Bundle "ZoomWin"
Bundle "YankRing.vim"
Bundle "netrw.vim"
Bundle "tlib"
Bundle "bufkill.vim"
"Bundle "CmdlineCompl.vim"
"Bundle "tsaleh/vim-align"
"Bundle "panozzaj/vim-autocorrect"
"Bundle "gregsexton/VimCalc"
Bundle "session.vim--Odding"
Bundle "rygwdn/vim-conque"
Bundle "ervandew/supertab"
Bundle "chrisbra/NrrwRgn"
Bundle "kien/ctrlp.vim"
if v:version >= 703
    Bundle "sjl/gundo.vim"
endif

" Camelcase stuff
"Bundle "camelcasemotion"
"Bundle "operator-camelize"


" Git stuff
Bundle "tpope/vim-fugitive"
Bundle "tpope/vim-git"
Bundle "int3/vim-extradite"
Bundle "gitolite.vim"
