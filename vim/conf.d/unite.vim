if index(keys(g:plugs), 'unite.vim') == -1
    finish
endif


" Unite
let g:unite_enable_start_insert = 0
let g:unite_source_history_yank_enable = 1

if executable('ag')
    let g:unite_source_grep_command = 'ag'
    let g:unite_source_grep_default_opts = '--nogroup --nocolor --column'
    let g:unite_source_grep_recursive_opt = ''
    let g:unite_source_rec_async_command=['ag', '--nocolor', '--nogroup', '--hidden', '-g', '', '--ignore=build', '--ignore=aioWebsite/src', '--ignore=*/.*venvs']
    "let g:unite_source_rec_max_cache_files = 0
    "call unite#custom#source('file_rec,file_rec/async', 'max_candidates', 0)
endif

function! s:config_unite()
    if exists('g:loaded_unite')
        call unite#filters#matcher_default#use(['matcher_fuzzy'])
        call unite#filters#sorter_default#use(['sorter_selecta'])
    endif
endfunction

autocmd vimrc VimEnter * call s:config_unite()

if has("nvim")
  nnoremap <C-S-p> :<C-u>Unite -no-split -buffer-name=files   -start-insert file_rec/neovim<cr>
else
  nnoremap <C-S-p> :<C-u>Unite -no-split -buffer-name=files   -start-insert file_rec/async<cr>
endif

nnoremap <Space> :<C-u>Unite -no-split -buffer-name=buffer  -start-insert buffer<cr>
nnoremap <C-g>   :<C-u>Unite -no-split -buffer-name=grep    -auto-preview grep:.<cr>

nnoremap <leader>o :<C-u>Unite -no-split -buffer-name=outline -auto-preview -start-insert outline<cr>
nnoremap <leader>y :<C-u>Unite -no-split -buffer-name=yank    -start-insert history/yank<cr>

"nnoremap <leader>r :<C-u>Unite -no-split -buffer-name=mru     -start-insert file_mru<cr>
"nnoremap <leader>e :<C-u>Unite -no-split -buffer-name=buffer  buffer<cr>

" Custom mappings for the unite buffer
autocmd vimrc FileType unite call s:unite_settings()
function! s:unite_settings()
  " Play nice with supertab
  let b:SuperTabDisabled=1

  " Enable navigation with control-j and control-k in insert mode
  "imap <buffer> <C-j>   <Plug>(unite_select_next_line)
  "imap <buffer> <C-k>   <Plug>(unite_select_previous_line)

  " Bring across some Ctrl-P mappings
  imap <silent><buffer><expr> <C-x> unite#do_action('split')
  imap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  imap <silent><buffer><expr> <C-t> unite#do_action('tabopen')

  " Allow clearing cache..
  imap <silent><buffer> <C-c> <Plug>(unite_redraw)

  nmap <buffer> <ESC> <Plug>(unite_exit)
  imap <silent><buffer> <C-o> <Plug>(unite_exit)
  nmap <silent><buffer> <C-o> <Plug>(unite_exit)
endfunction
