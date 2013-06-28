"let g:SuperTabDefaultCompletionType = "<c-x><c-o>"
"let g:SuperTabDefaultCompletionType = "context"
"let g:SuperTabCompletionContexts = ['s:ContextText', 's:ContextDiscover']
"let g:SuperTabContextTextOmniPrecedence = ['&omnifunc', '&completefunc']
"let g:SuperTabContextDiscoverDiscovery =
    "\ ["&completefunc:<c-x><c-u>", "&omnifunc:<c-x><c-o>"]

"let g:SuperTabLongestHighlight = 1
let g:SuperTabLongestEnhanced = 1
let g:SuperTabCrMapping = 0

"au FileType java call SuperTabSetDefaultCompletionType("<c-x><c-u>")
"au FileType cpp call SuperTabSetDefaultCompletionType("<c-x><c-n>")
"au BufWinEnter */sc/ta/*/marks call SuperTabSetDefaultCompletionType("<c-x><c-l>")

let g:SuperTabDefaultCompletionType = '<C-Tab>'

let g:ycm_key_list_select_completion = ['<C-TAB>', '<Down>']
let g:ycm_key_list_previous_completion = ['<C-S-TAB>', '<Up>']
let g:ycm_extra_conf_globlist = ['~/git/*','!~/*']
