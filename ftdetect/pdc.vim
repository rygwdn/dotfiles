" Pandoc

augroup filetypedetect
    au! BufNewFile,BufRead,StdinReadPost *.pdc	setlocal filetype=pdc
    au BufRead,BufNewFile *.pdc	set spell
    au BufRead,BufNewFile *.pdc	set wm=1
    au BufRead,BufNewFile *.pdc	set tw=100
    let g:tlist_pdc_settings = { 'lang' : 'pdc', 'tags' : { 'h' : 'header' } }
    "let g:tlist_pdc_settings='pdc;h:header;t:topic'
augroup END
