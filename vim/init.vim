" vim: fdm=marker
" vim: foldlevel=0
" --------------------------
" | rygwdn's vimrc         |
" | Version 1.0            |
" --------------------------

" TODO: repos to look at
" - https://github.com/NvChad/NvChad
" - https://github.com/nvim-telescope/telescope.nvim
" - https://github.com/nvim-treesitter/nvim-treesitter
" - https://github.com/kyazdani42/nvim-tree.lua
" - https://github.com/JoosepAlviste/nvim-ts-context-commentstring
" - https://github.com/akinsho/bufferline.nvim
" - https://github.com/famiu/feline.nvim
" - https://github.com/lukas-reineke/indent-blankline.nvim


" init ---------------------------------------- {{{
" When started as "evim", evim.vim will already have done these settings.
if v:progname =~? "evim"
    finish
endif

" Set python program to be the homebrew version
if executable("/usr/local/bin/python") == 1
    let g:python_host_prog='/usr/local/bin/python'
endif

" hack for windows :S
set rtp+=~/.vim

augroup vimrc
"    autocmd!
augroup END

" ------------------------------------------- }}}

" plugins {{{

filetype indent plugin off
filetype off

let s:win_shell = (has('win32') || has('win64')) && &shellcmdflag =~ '/'
let s:vim_dir = s:win_shell ? '$HOME/vimfiles' : '$HOME/.vim'
let g:bundle_dir = s:vim_dir . '/bundle'

" for testing firenvim config loading..
"let g:started_by_firenvim=1
"
if exists('g:started_by_firenvim')
  call plug#begin(g:bundle_dir)
  Plug 'glacambre/firenvim', { 'do': { _ -> firenvim#install(0) } }
  call plug#end()

  set laststatus=0
  au BufEnter github.com_*.txt set filetype=markdown
  let g:firenvim_config = { 
    \ 'globalSettings': {
      \ 'alt': 'all',
    \  },
    \ 'localSettings': {
      \ '.*': { },
    \ }
  \ }

  let fc = g:firenvim_config['localSettings']
  let fc['.*'] = { 'cmdline': 'firenvim', 'content': 'text', 'priority': 0, 'takeover': 'never' }
  "let fc['.*github.com.*'] = { 'takeover' : 'always', 'selector': 'textarea:not([readonly])' }
else
  runtime plugins.vim
endif

filetype on
filetype indent plugin on

" ------------------------------------------- }}}

" Operational settings -------------------------------------- {{{
set nocompatible    "Vim rocks! this must be first to avoid side effects.

syntax on                       " syntax on
filetype on                     " automatic file type detection
set autoread                    " watch for file changes by other programs
set visualbell                  " visual beep
set noautowrite                 " don't automatically write on :next, etc
set scrolloff=5                 " keep at least 5 lines above/below cursor
set sidescrolloff=5             " keep at least 5 columns left/right of cursor
set history=200                 " remember the last 200 commands
"set autochdir                   " current dir always matches curr file
set linebreak                   " wrap on words, not in the middle of them
set wrap                        " ...
set guioptions-=T               " no toolbar
"set formatoptions=l            " don't insert eols, just wrap
if has("mac") || has("macunix")
    set clipboard=unnamed           " use "* as the default register
else
    set clipboard=unnamedplus       " use "+ as the default register
endif

set encoding=utf-8

let g:maplocalleader=','          " all my macros start with ,
let g:mapleader=","               " set <Leader> to , instead of \

set number
if v:version >= 703
    set rnu                     " relative line nums
endif

" ----------------------------------------------------------------- }}}

" backup and tempdir settings {{{
set backup                      " produce *~ backup files
set backupext=~                 " add ~ to the end of backup files

let g:temp_path = '/tmp' " default
for dir in ["~/tmp/.vim", "~/.vim/tmp", "/tmp", "~/vimfiles/tmp", "C:\\Temp"]
    if glob(dir) != ""
        let g:temp_path = dir
        break
    endif
endfor

exec "set directory=" . g:temp_path . "//"
exec "set backupdir=" . g:temp_path

if v:version >= 703
    exec "set undodir=" . g:temp_path
    set undofile
endif

let g:yankring_history_dir = g:temp_path
" }}}-----------------------------------------------------------------

" mouse settings ---------------------------------------- {{{
set mouse=a                     " mouse support in all modes
set mousehide                   " hide the mouse when typing text

" ,p and shift-insert will paste the X buffer, even on the command line
nmap <S-Insert> "+p
imap <S-Insert> <C-O>:set paste<CR><C-r>+<C-O>:set nopaste<CR>
cmap <S-Insert> <C-O>:set paste<CR><C-r>+<C-O>:set nopaste<CR>

" -------------------------------------------------------- }}}

" global editing settings -----------------------------------------{{{
set expandtab                   " use spaces, not tabs
set smarttab                    " make <tab> and <backspace> smarter
set tabstop=8                   " tabstops of 8
set shiftwidth=4                " indents of 4
set softtabstop=4               " act like ts=4
set backspace=eol,start,indent  " allow backspacing over indent, eol, & start
set undolevels=1000             " number of forgivable mistakes
set updatecount=100             " write swap file to disk every 100 chars
set foldenable
set foldlevel=99999
set autowrite                   " write before :make
if has("nvim")
    set ttimeoutlen=-1
else
    set ttimeoutlen=50
endif

if v:version >= 703
    set colorcolumn=+1
endif

set splitright                  " vertical split opens new window on right

" When editing a file, always jump to the last known cursor position.
" Don't do it when the position is invalid or when inside an event handler
" (happens when dropping a file on gvim).
autocmd vimrc BufReadPost *
            \ if line("'\"") > 0 && line("'\"") <= line("$") |
            \   exe "normal g`\"" |
            \ endif
" ------------------------------------------------------------- }}}

" searching ------------------------------------------ {{{
set nohlsearch                   " enable search highlight globally
set incsearch                  " show matches as soon as possible
set noshowmatch                " don't show matching brackets when typing
set showfulltag                " Show full tags when doing search completion
set ignorecase smartcase       " case-insensitive if lower case
set gdefault                   " use ///g by default, now it switches it off

" disable last one highlight
nmap <LocalLeader><space> :noh<cr>
"nnoremap <esc> :noh<cr><esc>

" very magic searching
"nnoremap / /\v
"vnoremap / /\v

" ---------------------------------------------------- }}}

" handy commands & mappings ---------------------------- {{{

if has("nvim")
    nmap <BS> <C-h>
    tnoremap <Esc> <C-\><C-n>
    tnoremap <S-Esc> <Esc>
endif

if exists('g:vscode')
  xmap gc  <Plug>VSCodeCommentary
  nmap gc  <Plug>VSCodeCommentary
  omap gc  <Plug>VSCodeCommentary
  nmap gcc <Plug>VSCodeCommentaryLine
endif

" insert mode paste (like esc p i)
imap  "
imap ,,<C-v> +
nmap ,,<C-v> "+p

nmap Y y$

map <F4> :FSHere<CR>

" save and build
nmap <LocalLeader>m  :make!<cr>

" work with errors
nmap <LocalLeader>ln  :lnext<CR>
nmap <LocalLeader>lp  :lprevious<CR>
nmap <LocalLeader>cn  :cnext<CR>
nmap <LocalLeader>cp  :cprevious<CR>
nmap <LocalLeader>cc  :cc<CR>
nmap <LocalLeader>cw  :botright copen<CR>
nmap <LocalLeader>co  :botright copen<CR>
nmap <LocalLeader>cl  :cclose<CR>

" Add support for new versions of make
let &efm.= ",%D%*\\a[%*\\d]: Entering directory '%f',%X%*\\a[%*\\d]: Leaving directory '%f',%D%*\\a: Entering directory '%f',%X%*\\a: Leaving directory '%f',%DMaking %*\\a in %f,%f|%l| %m"

" use Q for formatting
map Q gq

" Move around windows
"nmap <c-l> l
"nmap <c-h> h
"nmap <c-k> k
"nmap <c-j> j
"map <C-a> 

" Auto close braces
"inoremap { {}O

" Handy commands
command! W w

" Switch tabs
nmap <C-Tab>   gt
imap <C-Tab>   <Esc>gt
nmap <C-S-Tab> gT
imap <C-S-Tab> <Esc>gT

nmap ,,q <Esc>
imap ,,q <Esc>
imap jj <Esc>

nmap <leader>f zf%A
vmap <leader>f zfA

" Sometimes I hate the defaults for these two in insert!
"inoremap <c-u> 
"inoremap <c-w> 

" Allow tab to jump between pairs
"nnoremap <tab> %
"vnoremap <tab> %

" --------------------------------------------- }}}

" command completion --------------------------- {{{

" Use the cool tab complete menu
set wildmenu
set wildignore+=*.o,*~,.lo
set suffixes+=.in,.a

" shell style completion, double tab cycles
set wildmode=list:longest,full

" -------------------------------------- }}}

" insert completion ----------------------------- {{{

" Ide style completion
set completeopt=menuone,preview,longest
" <CR> selects completion

""" "inoremap <expr> <CR>       pumvisible() ? "\<C-y>" : "\<C-g>u\<CR>"
""" inoremap <expr> <Esc>      pumvisible() ? "\<C-e>" : "\<Esc>"
inoremap <expr> <CR>       pumvisible() ? "\<C-y>" : "\<CR>"
inoremap <expr> <Down>     pumvisible() ? "\<C-n>" : "\<Down>"
inoremap <expr> <Up>       pumvisible() ? "\<C-p>" : "\<Up>"
inoremap <expr> <PageDown> pumvisible() ? "\<PageDown>\<C-p>\<C-n>" : "\<PageDown>"
inoremap <expr> <PageUp>   pumvisible() ? "\<PageUp>\<C-p>\<C-n>" : "\<PageUp>"

"set complete=.,w,b,u,U,t,i,d    " do lots of scanning on tab completion
"set complete-=k complete+=k
"set ofu=syntaxcomplete#Complete

" Close preview window automatically
autocmd vimrc InsertLeave * if pumvisible() == 0|pclose|endif

" ------------------------------------------------}}}

" visual/gui stuff -------------------------- {{{

set ruler		" show the cursor position all the time
"set lazyredraw                  " don't redraw when running macros
set showcmd		" display incomplete commands


" 1 height windows
set winminheight=1
set laststatus=2
set background=dark
set go-=TLr " Toolbar, scrollbars

if !has("nvim")
    let &t_Co=256
    let &t_AF="\e[38;5;%dm"
    let &t_AB="\e[48;5;%dm"
    let &t_ti.="\e[1 q"
    let &t_SI.="\e[5 q"
    let &t_EI.="\e[1 q"
    let &t_te.="\e[0 q"
endif

if !exists("g:colors_name") || g:colors_name != "candycode"
    try
        colorscheme candycode
    catch /^Vim\%((\a\+)\)\=:E185/
        " probably not installed
    endtry
endif


" --------------------------------------- }}}

" file type stuff ------------------- {{{

set diffopt=filler,iwhite       " ignore all whitespace and sync

" detection {{{
autocmd vimrc BufNewFile,BufRead *.as set ft=actionscript
autocmd vimrc BufNewFile,BufRead *.m set ft=objc
let g:filetype_m='objc'
autocmd vimrc BufNewFile,BufRead *.pl set ft=prolog
autocmd vimrc BufNewFile,BufRead *.md set ft=mkd
" }}}

"" C, C++ stuff {{{
autocmd vimrc filetype c,cpp set spell
set tags+=./tags;$HOME      " add tags files from current dir up to $HOME
set tags+=./.git/tags;$HOME " add tags in parent git dir from current dir up to $HOME
let g:load_doxygen_syntax=1
" }}}

" help files, make return jump to tag {{{
autocmd vimrc FileType help nmap <buffer> <Return> <C-]>
" }}}

" Latex {{{
let g:tex_flavor='latex'

function! LatexEvinceSearch()
    execute "!cd " . LatexBox_GetTexRoot() . '; evince_dbus.py "`basename ' . LatexBox_GetOutputFile(). '`" ' . line('.') . ' "%:p"'
endfun
command! LatexEvinceSearch call LatexEvinceSearch()

autocmd vimrc FileType tex map <Leader>ls :silent LatexEvinceSearch<CR>
autocmd vimrc FileType tex imap <buffer> ]] <Plug>LatexCloseCurEnv

" }}}

" Mail {{{
autocmd vimrc FileType mail set tw=0 spell colorcolumn=73
" }}}

" VimOutliner {{{
autocmd vimrc BufEnter *.otl set ft=votl
autocmd vimrc FileType otl map <M-S-j> <M-S-Down>
autocmd vimrc FileType otl map <M-S-k> <M-S-Up>
let g:otl_map_tabs = 1
autocmd vimrc FileType otl set tw=100 ts=3 sts=3 sw=3 fo-=t foldlevel=10 colorcolumn=0
let g:no_otl_insert_maps = 1
" }}}

" html {{{
augroup html
    let g:xml_use_xhtml = 1
    autocmd vimrc BufWinEnter *.html,*.php imap <S-CR> <br /><Right><CR>
augroup END
" }}}

" omnicomplete {{{
autocmd vimrc FileType javascript set omnifunc=javascriptcomplete#CompleteJS
autocmd vimrc FileType html set omnifunc=htmlcomplete#CompleteTags
autocmd vimrc FileType css set omnifunc=csscomplete#CompleteCSS
autocmd vimrc FileType xml set omnifunc=xmlcomplete#CompleteTags
autocmd vimrc FileType php set omnifunc=phpcomplete#CompletePHP
autocmd vimrc FileType c set omnifunc=ccomplete#Complete
" }}}

"" Python stuff {{{
autocmd vimrc FileType python if &rtp =~ "pylint" | compiler pylint | endif
autocmd vimrc FileType python setlocal foldmethod=indent
" }}}

" --------------------------------------------------- }}}

" includes {{{

" nvim
if has("nvim")
    for src in split(glob("~/.config/nvim/conf.d/*.vim"), "\n")
        execute "source " . src
    endfor
else
    " Unix
    for src in split(glob("~/.vim/conf.d/*.vim"), "\n")
        execute "source " . src
    endfor

    " Windows
    for src in split(glob("~/vimfiles/conf.d/*.vim"), "\n")
        execute "source " . src
    endfor
endif

" }}}

"  Includes ------------------------------- {{{

if has("unix")
    let s:uname = system("echo -n `uname`")
    if s:uname == "Darwin"
        runtime osx.vimrc
    else
        runtime linux.vimrc
    endif
elseif has("macunix")
    runtime osx.vimrc
elseif has("win32")
    runtime win.vimrc
endif

if filereadable(expand("~/.vimrc.local"))
    source $HOME/.vimrc.local
endif
" ---------------------------------------------- }}}

"  Fix for https://github.com/equalsraf/neovim-qt/issues/417 {{{
if @% == ""
  bd
endif
"  ---------------------------------------------------------- }}}
