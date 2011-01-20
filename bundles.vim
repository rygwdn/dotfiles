" Deps
Bundle 'L9'

" Snippets
"Bundle "UltiSnips"
Bundle "git://github.com/rygwdn/ultisnips.git"

" Colorschemes
Bundle "candycode.vim"
Bundle "blackboard.vim"

" Programming
Bundle "git://github.com/tpope/vim-ragtag.git"
Bundle "DoxygenToolkit.vim"
Bundle "FSwitch"
Bundle "git://github.com/rygwdn/vim-ipython.git"
Bundle "git://github.com/rygwdn/vim-pylint.git"
Bundle "git://github.com/rygwdn/latexbox-rubber.git"

if has("python")
    Bundle "git://github.com/rygwdn/rope-omni.git"
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
Bundle "git://github.com/tpope/vim-rails.git"
Bundle "git://github.com/tpope/vim-cucumber.git"
Bundle "git://github.com/vim-ruby/vim-ruby.git"
Bundle "git://github.com/msanders/cocoa.vim.git"
Bundle "git://github.com/sukima/xmledit.git"
Bundle "git://github.com/Rip-Rip/clang_complete.git"
Bundle "git://github.com/Raimondi/vimoutliner.git"
Bundle "git://github.com/nvie/vim-rst-tables.git"
Bundle "git://github.com/ingydotnet/yaml-vim.git"


" Search
Bundle "IndexedSearch"
Bundle "git://github.com/mileszs/ack.vim.git"
Bundle "git://github.com/gmarik/vim-visual-star-search.git"

" Open files
Bundle "git://github.com/scrooloose/nerdtree.git"

" Movement
Bundle "matchit.zip"
Bundle "git://github.com/kana/vim-operator-user.git"

" Navigation
Bundle "Marks-Browser"
Bundle "FuzzyFinder"
Bundle "taglist.vim"

" Operations
Bundle "git://github.com/tpope/vim-repeat.git"
Bundle "git://github.com/tpope/vim-surround.git"
Bundle "git://github.com/michaeljsmith/vim-indent-object.git"

" Utility
Bundle "VOoM"
Bundle "ZoomWin"
Bundle "YankRing.vim"
Bundle "netrw.vim"
Bundle "tlib"
Bundle "bufkill.vim"
Bundle "CmdlineCompl.vim"
Bundle "git://github.com/tsaleh/vim-align.git"
Bundle "git://github.com/panozzaj/vim-autocorrect.git"
Bundle "https://github.com/gregsexton/VimCalc.git"
Bundle "session.vim--Odding"
Bundle "git://github.com/rygwdn/vim-conque.git"
Bundle "git://github.com/ervandew/supertab.git"
if v:version >= 703
    Bundle "git://github.com/sjl/gundo.vim.git"
endif

" Camelcase stuff
Bundle "camelcasemotion"
Bundle "operator-camelize"


" Git stuff
Bundle "git://github.com/tpope/vim-fugitive.git"
Bundle "git://github.com/tpope/vim-git.git"
Bundle "gitolite.vim"
