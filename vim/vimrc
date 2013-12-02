" vim: fdm=marker
" vim: foldlevel=0
" --------------------------
" | rygwdn's vimrc         |
" | Version 1.0            |
" --------------------------


" init ---------------------------------------- {{{
" When started as "evim", evim.vim will already have done these settings.
if v:progname =~? "evim"
    finish
endif

" hack for windows :S
set rtp+=~/.vim
" ------------------------------------------- }}}

" Bundles & pathogen {{{

filetype indent plugin off
filetype off

runtime vundles.vim

" setup runtime path using the excellent vim-pathogen:
" http://github.com/tpope/vim-pathogen
"call pathogen#runtime_append_all_bundles() " handled by Vundle
call pathogen#surround('~/.vim/manual/{}')
call pathogen#surround('~/vimfiles/manual/{}')
call pathogen#surround('~/.vim/pre/{}')
call pathogen#surround('~/vimfiles/pre/{}')
call pathogen#helptags()

function! s:clean_rtp()
    let n = []
    for dir in pathogen#split(&rtp)
        if isdirectory(dir)
            call add(n, dir)
        endif
    endfor
    let &rtp = pathogen#join(n)
endfunction
call s:clean_rtp()

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

let maplocalleader=','          " all my macros start with ,
let mapleader=","               " set <Leader> to , instead of \

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
    echom "Failed to find valid temp path"
endfor

exec "set directory=" . g:temp_path
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

" this makes the mouse paste a block of text without formatting it 
" (good for code)
map <MouseMiddle> <esc>"+p

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

if v:version >= 703
    set colorcolumn=+1
endif

set splitright                  " vertical split opens new window on right

" When editing a file, always jump to the last known cursor position.
" Don't do it when the position is invalid or when inside an event handler
" (happens when dropping a file on gvim).
autocmd BufReadPost *
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
nnoremap / /\v
vnoremap / /\v

" ---------------------------------------------------- }}}

" handy commands & mappings ---------------------------- {{{

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
nmap <c-l> l
nmap <c-h> h
nmap <c-k> k
nmap <c-j> j
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

" used with CTRL-X CTRL-K
"au BufRead,BufNew *.txt,*.tex,*.pdc set dictionary=/usr/share/dict/words

"set complete=.,w,b,u,U,t,i,d    " do lots of scanning on tab completion
"set complete-=k complete+=k
"set ofu=syntaxcomplete#Complete

" Close preview window automatically
"autocmd CursorMovedI * if pumvisible() == 0|pclose|endif
autocmd InsertLeave * if pumvisible() == 0|pclose|endif

" ------------------------------------------------}}}

" visual/gui stuff -------------------------- {{{

set cmdheight=2                 " make command line two lines high
set ruler		" show the cursor position all the time
"set lazyredraw                  " don't redraw when running macros
set showcmd		" display incomplete commands

"colorscheme default2
if stridx(&rtp, "blackboard") != -1
    colorscheme blackboard
endif

" 1 height windows
set winminheight=1

set laststatus=2

if has("gui_running")
    " window size
    "set lines=40
    "set columns=80
    if stridx(&rtp, "candycode") != -1
        colorscheme candycode
    endif

    set guifont=DejaVu\ Sans\ Mono\ for\ Powerline\ 9
    let g:Powerline_symbols="fancy"

    set cursorline cursorcolumn
    au WinLeave * set nocursorline nocursorcolumn
    au WinEnter * set cursorline cursorcolumn

    set go-=TLr " Toolbar, scrollbars
else
    set bg=dark
endif
" --------------------------------------- }}}

" file type stuff ------------------- {{{

set diffopt=filler,iwhite       " ignore all whitespace and sync

" detection {{{
au BufNewFile,BufRead *.as set ft=actionscript
au BufNewFile,BufRead *.m set ft=objc
let filetype_m='objc'
au BufNewFile,BufRead *.pl set ft=prolog
" }}}

"" C, C++ stuff {{{
au filetype c,cpp set spell
set tags+=./tags;$HOME      " add tags files from current dir up to $HOME
set tags+=./.git/tags;$HOME " add tags in parent git dir from current dir up to $HOME
let g:load_doxygen_syntax=1
" }}}

" help files, make return jump to tag {{{
autocmd FileType help nmap <buffer> <Return> <C-]>
" }}}

" Latex {{{
let g:tex_flavor='latex'
"au BufWritePost *.tex Rubber

function! LatexEvinceSearch()
    execute "!cd " . LatexBox_GetTexRoot() . '; evince_dbus.py "`basename ' . LatexBox_GetOutputFile(). '`" ' . line('.') . ' "%:p"'
endfun
command! LatexEvinceSearch call LatexEvinceSearch()

au FileType tex map <Leader>ls :silent LatexEvinceSearch<CR>
au FileType tex imap <buffer> ]] <Plug>LatexCloseCurEnv

" }}}

" Mail {{{
au FileType mail set tw=0 spell colorcolumn=73
" }}}

" VimOutliner {{{
autocmd BufEnter *.otl set ft=votl
au FileType otl map <M-S-j> <M-S-Down>
au FileType otl map <M-S-k> <M-S-Up>
let otl_map_tabs = 1
au FileType otl set tw=100 ts=3 sts=3 sw=3 fo-=t foldlevel=10 colorcolumn=0
let no_otl_insert_maps = 1
" }}}

" html {{{
augroup html
    let xml_use_xhtml = 1
    au BufWinEnter *.html,*.php imap <S-CR> <br /><Right><CR>
augroup END
" }}}

" omnicomplete {{{
autocmd FileType javascript set omnifunc=javascriptcomplete#CompleteJS
autocmd FileType html set omnifunc=htmlcomplete#CompleteTags
autocmd FileType css set omnifunc=csscomplete#CompleteCSS
autocmd FileType xml set omnifunc=xmlcomplete#CompleteTags
autocmd FileType php set omnifunc=phpcomplete#CompletePHP
autocmd FileType c set omnifunc=ccomplete#Complete
" }}}

"" Python stuff {{{
autocmd FileType python if &rtp =~ "pylint" | compiler pylint | endif
autocmd FileType python setlocal foldmethod=indent
" }}}

" --------------------------------------------------- }}}

" includes {{{

" Unix
for src in split(glob("~/.vim/conf.d/*.vim"), "\n")
    execute "source " . src
endfor

" Windows
for src in split(glob("~/vimfiles/conf.d/*.vim"), "\n")
    execute "source " . src
endfor

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
" ---------------------------------------------- }}}
