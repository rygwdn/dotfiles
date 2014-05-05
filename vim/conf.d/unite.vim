" Unite
let g:unite_enable_start_insert = 1
let g:unite_source_history_yank_enable = 1

"let g:unite_split_rule = "botright"
"let g:unite_force_overwrite_statusline = 0
"let g:unite_winheight = 10

"call unite#custom_source('file_rec,file_rec/async,file_mru,file,buffer,grep',
"      \ 'ignore_pattern', join([
"      \ '\.git/',
"      \ ], '\|'))

function! s:config_unite()
    if exists('g:loaded_unite')
        call unite#filters#matcher_default#use(['matcher_fuzzy'])
        call unite#filters#sorter_default#use(['sorter_rank'])
    endif
endfunction

" Unite should be installed..
if index(keys(g:bundle_names), 'unite.vim') > -1
    au VimEnter * call s:config_unite()
endif

nnoremap <C-S-p> :<C-u>Unite -no-split -buffer-name=files   -start-insert file_rec/async:!<cr>
nnoremap <Space> :<C-u>Unite -no-split -buffer-name=buffer  buffer<cr>

nnoremap <leader>o :<C-u>Unite -no-split -buffer-name=outline -start-insert outline<cr>
nnoremap <leader>y :<C-u>Unite -no-split -buffer-name=yank    history/yank<cr>

"nnoremap <leader>r :<C-u>Unite -no-split -buffer-name=mru     -start-insert file_mru<cr>
"nnoremap <leader>e :<C-u>Unite -no-split -buffer-name=buffer  buffer<cr>

" Custom mappings for the unite buffer
autocmd FileType unite call s:unite_settings()
function! s:unite_settings()
  " Play nice with supertab
  let b:SuperTabDisabled=1

  " Enable navigation with control-j and control-k in insert mode
  imap <buffer> <C-j>   <Plug>(unite_select_next_line)
  imap <buffer> <C-k>   <Plug>(unite_select_previous_line)

  " Bring across some Ctrl-P mappings
  imap <silent><buffer><expr> <C-x> unite#do_action('split')
  imap <silent><buffer><expr> <C-v> unite#do_action('vsplit')
  imap <silent><buffer><expr> <C-t> unite#do_action('tabopen')

  nmap <buffer> <ESC> <Plug>(unite_exit)
  imap <silent><buffer> <C-o> <Plug>(unite_exit)
endfunction
