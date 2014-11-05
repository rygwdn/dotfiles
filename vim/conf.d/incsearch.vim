map /  <Plug>(incsearch-forward)
map ?  <Plug>(incsearch-backward)
map g/ <Plug>(incsearch-stay)


" :h g:incsearch#auto_nohlsearch
set hlsearch
let g:incsearch#auto_nohlsearch = 1
map n  <Plug>(incsearch-nohl-n)
map N  <Plug>(incsearch-nohl-N)
map *  <Plug>(incsearch-nohl-*)
map #  <Plug>(incsearch-nohl-#)
map g* <Plug>(incsearch-nohl-g*)
map g# <Plug>(incsearch-nohl-g#)

" very magic by default
let g:incsearch#magic = '\v'

"augroup incsearch-keymap
"    autocmd!
"    autocmd VimEnter call s:incsearch_keymap()
"augroup END
"function! s:incsearch_keymap()
"    IncSearchNoreMap <C-n> <Over>(incsearch-next)
"    IncSearchNoreMap <C-p> <Over>(incsearch-prev)
"endfunction
