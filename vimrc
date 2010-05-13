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


" setup runtime path using the excellent vim-pathogen:
" http://github.com/tpope/vim-pathogen
call pathogen#runtime_append_all_bundles()
call pathogen#runtime_prepend_subdirectories('~/.vim/manual')
call pathogen#helptags()

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
set hidden                      " allow hidden windows
"set formatoptions=l            " don't insert eols, just wrap

let maplocalleader=','          " all my macros start with ,
let mapleader=","               " set <Leader> to , instead of \
" ----------------------------------------------------------------- }}}


" backup settings {{{
set backup                      " produce *~ backup files
set backupext=~                 " add ~ to the end of backup files
set directory=~/tmp/.vim
set backupdir=~/tmp/.vim
" }}}-----------------------------------------------------------------


" mouse settings ---------------------------------------- {{{
set mouse=a                     " mouse support in all modes
set mousehide                   " hide the mouse when typing text

" ,p and shift-insert will paste the X buffer, even on the command line
nmap <LocalLeader>p i<S-MiddleMouse><ESC>
imap <S-Insert> <S-MiddleMouse>
cmap <S-Insert> <S-MiddleMouse>

" this makes the mouse paste a block of text without formatting it 
" (good for code)
map <MouseMiddle> <esc>"*p

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

set splitright                  " vertical split opens new window on right

" match if/then/else
runtime macros/matchit.vim

" don't match parens
let loaded_matchparen=1
" ------------------------------------------------------------- }}}


" searching ------------------------------------------ {{{
set nohlsearch                 " disable search highlight globally
set incsearch                  " show matches as soon as possible
set noshowmatch                " don't show matching brackets when typing
set showfulltag                " Show full tags when doing search completion

" disable last one highlight
nmap <LocalLeader>nh :nohlsearch<cr>
" ---------------------------------------------------- }}}


" handy commands & mappings ---------------------------- {{{

" insert mode paste (like esc p i)
imap  "

nmap Y y$

map <F4> :FSHere<CR>

" save and build
nmap <LocalLeader>wm  :w<cr>:make<cr>

" work with errors
nmap <LocalLeader>ln  :lnext<CR>
nmap <LocalLeader>lp  :lprevious<CR>
nmap <LocalLeader>cn  :cnext<CR>
nmap <LocalLeader>cp  :cprevious<CR>

" find merge conflict markers
map <LocalLeader>fc /\v^[<=>]{7}( .*\|$)<CR>

" Don't use Ex mode, use Q for formatting
map Q gq

map <F12> :!ctags -a --c++-kinds=+p --fields=+iaS --extra=+q %<CR><CR>
map <F11> :make!<CR>

" Move around windows
map <c-s-l> l
map <c-s-h> h
map <c-s-k> k
map <c-s-j> j
map <C-a> 

" Auto close braces
inoremap { {}O

" Handy commands
command W w
command UP !svn up
command CI !svn ci --editor-cmd "gvim -f"

" Sometimes I hate the defaults for these two in insert!
"inoremap <c-u> 
"inoremap <c-w> 

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
inoremap <expr> <CR> pumvisible() ? "\<C-y>" : "\<C-g>u\<CR>"

" used with CTRL-X CTRL-K
"au BufRead,BufNew *.txt,*.tex,*.pdc set dictionary=/usr/share/dict/words

"set complete=.,w,b,u,U,t,i,d    " do lots of scanning on tab completion
"set complete-=k complete+=k
"set ofu=syntaxcomplete#Complete

" Close preview window automatically
"autocmd CursorMovedI * if pumvisible() == 0|pclose|endif
autocmd InsertLeave * if pumvisible() == 0|pclose|endif

" ------------------------------------------------}}}


" visual stuff -------------------------- {{{

set cmdheight=2                 " make command line two lines high
set ruler		" show the cursor position all the time
set lazyredraw                  " don't redraw when running macros
set showcmd		" display incomplete commands

"colorscheme default2
colorscheme blackboard
if has("gui_running")
    " window size
    set lines=40
    set columns=80
    colorscheme candycode
else
    set bg=dark
endif

" 1 height windows
set winminheight=1

" --------------------------------------- }}}


" file type stuff ------------------- {{{

" Enable file type detection.
" Use the default filetype settings, so that mail gets 'tw' set to 72,
" 'cindent' is on in C files, etc.
" Also load indent files, to automatically do language-dependent indenting.
filetype indent on
filetype plugin on
"set autoindent smartindent      " turn on auto/smart indenting

"" C, C++ stuff
" make 'make' not spew junk
let g:load_doxygen_syntax=1
let g:DoxygenToolkit_authorName="Ryan Wooden (100079872)"
au filetype c,cpp set makeprg=make\ -s\ -i
au filetype c,cpp set spell
au filetype c,cpp map <leader>d :Dox<CR>

" recognize objective C files
au BufNewFile,BufRead *.m set ft=objc
au FileType objc set syntax=objc.doxygen
let filetype_m='objc'

" Rec prolog files
au BufNewFile,BufRead *.pl set ft=prolog

" help files, make return jump to tag
autocmd FileType help nmap <buffer> <Return> <C-]>

" Word processing (latex, some? plain text)
cabbr wp call Wp()
fun! Wp()
    set wrap
    set linebreak
    source ~/.vim/bundles/autocorrect/autocorrect.vim
    nnoremap j gj
    nnoremap k gk
    nnoremap 0 g0
    nnoremap $ g$
    nnoremap <Home> g0
    nnoremap <End> g$
    set nonumber
    set spell spelllang=en_us
endfu


" Latex
let g:tex_flavor='latex'

" Automatically make on write
function! MakeTex()
    silent make!
endfunction
au BufWritePost *.tex call MakeTex()

" Use a makefile :)
" Or not... - set to makeprg=make to automake
au FileType tex set makeprg=
au FileType tex call Wp()


"Mail
au FileType mail set tw=70 spell



" Warn over 77, error over 80
au BufWinEnter *.c,*.java,*.cpp,*.h let w:m1=matchadd('Search', '\%<81v.\%>77v', -1)
au BufWinEnter *.c,*.java,*.cpp,*.h let w:m2=matchadd('ErrorMsg', '\%>80v.\+', -1)

" Highlight whitespace at end of line
highlight ExtraWhitespace ctermbg=darkgreen guibg=darkgreen
autocmd Syntax * syn match ExtraWhitespace /\s\+$\| \+\ze\t/ containedin=ALL


"autocmd BufEnter *.otl set ft=vo_base
au FileType otl map <M-S-j> <M-S-Down>
au FileType otl map <M-S-k> <M-S-Up>
let otl_map_tabs = 1
au FileType otl set tw=100 ts=3 sw=3 fo-=t foldlevel=10
let no_otl_insert_maps = 1

augroup html
    let xml_use_xhtml = 1
    au BufWinEnter *.html,*.php imap <S-CR> <br /><Right><CR>
augroup END

set diffopt=filler,iwhite       " ignore all whitespace and sync

"autocmd FileType python set omnifunc=pythoncomplete#Complete
autocmd FileType javascript set omnifunc=javascriptcomplete#CompleteJS
autocmd FileType html set omnifunc=htmlcomplete#CompleteTags
autocmd FileType css set omnifunc=csscomplete#CompleteCSS
autocmd FileType xml set omnifunc=xmlcomplete#CompleteTags
autocmd FileType php set omnifunc=phpcomplete#CompletePHP
autocmd FileType c set omnifunc=ccomplete#Complete

"autocmd FileType python set ft=python.doxygen | delcommand HiLink
autocmd FileType python set ft=python.doxygen

" --------------------------------------------------- }}}


" quickfix window tweaks -------------------------------- {{{

" 	adjust window height
au FileType qf call AdjustWindowHeight(3, 10)
function! AdjustWindowHeight(minheight, maxheight)
  exe max([min([line("$"), a:maxheight]), a:minheight]) . "wincmd _"
endfunction

" ------------------------------------------------------- }}}


" screen stuff ------------------------------- {{{

autocmd BufEnter * let &titlestring = "vim[" . expand("%:t") . "]"
if &term == "screen"
    set t_ts=k
    set t_fs=\
endif

if &term == "screen" || &term == "xterm"
    set title
endif

" ---------------------------------------------- }}}


" Plugins {{{

"helptags ~/.vim/doc

let g:yankring_history_dir = "/home/rwooden/tmp/.vim/"
command JCommentWriter silent call JCommentWriter()
let g:AutoClosePairs = {} 
"{'(': ')', '[': ']', '"': '"'} 


let g:surround_45 = "**\r**"

map <silent> <F3> :SwitchCodeAndTest<CR>


" Viki ----------------------------------- {{{

au FileType tex let b:vikiFamily="LaTeX"

" ---------------------------------------- }}}

" Conque shell ----------------------- {{{

command CV ConqueVSplit
command CC Conque
command CS ConqueSplit

" ---------------------------------------- }}}

" fuzzy finder stuff ----------------------- {{{

let g:fuzzy_matching_limit = 20
map <leader>f :FufFile<CR>
map <leader>b :FufBuffer<CR>
nmap <space> :FufBuffer<CR>

let g:fuf_keyNextPattern  = "<C-n>"
let g:fuf_keyPrevPattern  = "<C-p>" 

let g:fuf_keyNextMode     = "<C-u>"
let g:fuf_keyPrevMode     = "<C-i>"

let g:fuf_keyOpen         = "<CR> "
let g:fuf_keyOpenSplit    = "<C-j>"
let g:fuf_keyOpenTabpage  = "<C-t>"
let g:fuf_keyOpenVsplit   = "<C-l>"


" ---------------------------------------- }}}

" RopeVim -------------------------------- {{{

let ropevim_codeassist_maxfixes=10
let ropevim_vim_completion=1
let ropevim_extended_complete=1
let ropevim_guess_project=1
"let ropevim_enable_autoimport=0

let $PYTHONPATH .= ":/home/rwooden/src/rope:/home/rwooden/src/ropemode:/home/rwooden/src/ropevim"
source $HOME/src/ropevim/ropevim.vim

" ------------------------------------------------------ }}}

" SuperTab stuff ------------------------------------------ {{{

"let g:SuperTabDefaultCompletionType = "<c-x><c-u>"
let g:SuperTabDefaultCompletionType = "context"
let g:SuperTabLongestHighlight = 1

" ------------------------------------------------------ }}}


" Eclim stuff ------------------------------------------------ {{{
let g:EclimDisabled=1
augroup java
    autocmd FileType java set makeprg=javac\ %
    autocmd FileType java :nnoremap <silent> <buffer> <leader>i :JavaImport<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>d :JavaDocSearch -x declarations<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>s :JavaSearchContext<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>c :JavaCorrect<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>v :Validate<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>jc :call JCommentWriter()<cr>
    autocmd FileType java let b:jcommenter_class_author='Ryan Wooden, 100079872'
    autocmd FileType java let b:jcommenter_file_author='Ryan Wooden, 100079872'
augroup END

" Only enable eclim for filtypes listed here!
autocmd FileType java call EnableEclim()
function! EnableEclim()
    if exists("g:EclimDisabled")
        unlet g:EclimDisabled
        runtime! plugin/eclim.vim
        " HACK!!!!!
python << EOF
import vim
ft = vim.eval("&ft")
vim.command("set ft=%s" % ft)
EOF
    endif
endfunction

au BufWinEnter */sc/jv/*.java set tabstop=3 shiftwidth=3 sts=3
au BufEnter */sc/ta/*/marks call SuperTabSetDefaultCompletionType("<c-x><c-l>")

let g:EclimPythonValidate = 1
"let g:EclimNailgunClient = 'external'
let g:EclimBrowser = 'firefox'

command EclimStart silent !eclipse &> /dev/null &
command PR ProjectRefresh

" ------------------------------------------------------------- }}}


" TlistToo stuff ----------------------------------------------- {{{
let g:Tlist_Auto_Open = 0
map <F5> :TlistToo<CR>
let Tlist_Process_File_Always = 1
au FileType taglist set nospell
au FileType taglist set sw=2
au FileType taglist set fdm=indent

" ----------------------------------------------------------------- }}}


" BufTabs ------------------------------------------------- {{{

"set laststatus=2                        " always have a status bar, even if only one window!
"let g:buftabs_in_statusline=1
"let g:buftabs_only_basename=1
"let g:buftabs_active_highlight_group="Visual"

" ------------------------------------------------------------ }}}


" BlogIt ------------------------------------------------- {{{

let blogit_unformat='pandoc --from=html --to=markdown --email-obfuscation=none'
let blogit_format='pandoc --from=markdown --to=html --no-wrap --email-obfuscation=none'

command Com Blogit commit
command Pub Blogit publish
command Bls Blogit ls
command Bl Bls
command Bnew Blogit new

" ------------------------------------------------------------ }}}


" }}}
