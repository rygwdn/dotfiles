
let g:cur_marks="marking.otl"
au BufWinEnter */sc/ta*.txt source ~/projects/vim/marking-help/fuz.vim
au BufWinEnter */sc/ta*.txt set completeopt-=longest
au BufWinEnter */sc/ta*.txt set completefunc=CompleteMarks
au BufWinEnter */sc/ta*.txt set omnifunc=CompleteMarks
au BufWinEnter */sc/ta*.txt YRToggle(0)
au BufWinEnter */sc/ta*.txt set colorcolumn=88
au BufWinEnter */sc/ta*.txt set list
au BufWinEnter */sc/ta*.txt set listchars=tab:>-
au BufWinEnter */sc/ta*.txt runtime syntax/c.vim
"au BufWinEnter */sc/ta*.txt set acd
au BufWinEnter */sc/ta*.txt set indentexpr=
