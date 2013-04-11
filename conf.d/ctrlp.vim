nmap <Space> :CtrlPBuffer<CR>
let g:ctrlp_map = '<c-s-p>'
let g:ctrlp_custom_ignore = '\v([\/]\.(git|hg|svn)|.*\/docs\/.*|.*\/submodule-gmock\/.*)$'
let g:ctrlp_cmd = 'CtrlP'
let g:ctrlp_user_command = ['.git', 'cd %s && git ls-files && git ls-files --exclude-standard --other']
