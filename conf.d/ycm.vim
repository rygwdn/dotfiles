nnoremap <leader>jd :YcmCompleter GoToDefinitionElseDeclaration<CR>

function! g:UltiSnips_Complete()
    if pumvisible()
        return "\<C-n>"
    else
        if g:UltiSnipsExpandTrigger == g:UltiSnipsJumpForwardTrigger
            call UltiSnips_ExpandSnippetOrJump()
        else
            call UltiSnips_ExpandSnippet()
        endif

        if g:ulti_expand_res == 0
            return "\<TAB>"
        endif
    endif

    return ""
endfunction

function! g:UltiSnips_YCM_CY()
    if pumvisible()
        call UltiSnips_ExpandSnippet()

        if g:ulti_expand_res == 0
            return "\<C-Y>"
        endif

        return ""
    else
        return "\<C-Y>"
    endif
endfunction

function! g:UltiSnips_YCM_CR()
    if pumvisible()
        return g:UltiSnips_YCM_CY()
    else
        return "\<CR>"
    endif
endfunction

let s:bundle_names = map(copy(g:bundles), 'v:val.name')

if index(s:bundle_names, "YouCompleteMe") >= 0 && index(s:bundle_names, "ultisnips") >= 0
    au BufEnter * inoremap <silent> <Tab> <C-R>=g:UltiSnips_Complete()<CR>
    au BufEnter * inoremap <silent> <C-Y> <C-R>=g:UltiSnips_YCM_CY()<CR>
    au BufEnter * inoremap <silent> <CR> <C-R>=g:UltiSnips_YCM_CR()<CR>
    let g:ycm_key_list_select_completion = ['<Down>']
else
    let g:ycm_key_list_select_completion = ['<TAB>', '<Down>']
endif

let g:ycm_key_list_previous_completion = ['<S-TAB>', '<Up>']
let g:ycm_extra_conf_globlist = ['~/git/*','!~/*']

let g:ycm_filetype_blacklist = {
    \ 'notes' : 1,
    \ 'markdown' : 1,
    \ 'text' : 1,
    \ 'ruby' : 1,
    \ 'votl' : 1,
    \}
