" setup {{{1
"vim: fdm=marker fdl=0

let s:win_shell = (has('win32') || has('win64')) && &shellcmdflag =~ '/'
let s:vim_dir = s:win_shell ? '$HOME/vimfiles' : '$HOME/.vim'
let s:bundle_dir = s:vim_dir . '/bundle'

call plug#begin(s:bundle_dir)

" }}}

" File types {{{

Plug 'dag/vim-fish'
Plug 'vim-scripts/candycode.vim'

" Add surround commands
"Plug 'tpope/vim-surround'

" Comment/uncomment. Provdes "gcc" (among others)
Plug 'tpope/vim-commentary'

" I mostly use this for the ":S" command which is awesome
Plug 'tpope/vim-abolish', {'on': ['S', 'Subvert', 'Abolish']}

" }}}

call plug#end()
