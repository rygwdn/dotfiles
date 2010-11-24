" Like textmate's command-t, but better

let g:fuzzy_matching_limit = 20
map <leader>ff :FufFile<CR>
map <leader>fr :FufCoverageFile<CR>
map <leader>b :FufBuffer<CR>
nmap <space> :FufBuffer<CR>

" abbrev for recursive
let g:fuf_abbrevMap = {"^\*" : ["**/",],}

let g:fuf_keyNextPattern  = "<C-n>"
let g:fuf_keyPrevPattern  = "<C-p>" 

let g:fuf_keyNextMode     = "<C-u>"
let g:fuf_keyPrevMode     = "<C-i>"

let g:fuf_keyOpen         = "<CR> "
let g:fuf_keyOpenSplit    = "<C-j>"
let g:fuf_keyOpenTabpage  = "<C-t>"
let g:fuf_keyOpenVsplit   = "<C-l>"

