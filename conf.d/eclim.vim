" Integrate eclipse

let g:EclimDisabled=1
augroup java
    autocmd FileType java set makeprg=javac\ %
    autocmd FileType java :nnoremap <silent> <buffer> <leader>i :JavaImport<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>d :JavaDocSearch -x declarations<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>s :JavaSearchContext<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>c :JavaCorrect<cr>
    autocmd FileType java :nnoremap <silent> <buffer> <leader>v :Validate<cr>
    autocmd FileType java let b:jcommenter_class_author='Ryan Wooden, 100079872'
    autocmd FileType java let b:jcommenter_file_author='Ryan Wooden, 100079872'
augroup END

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

"let g:EclimNailgunClient = 'external'
let g:EclimPythonValidate = 1
let g:EclimBrowser = 'firefox'
let g:EclimEclipseHome = $HOME . '/src/eclipse'
let g:EclimTaglistEnabled = 0

command! EclimStart silent !eclipse &> /dev/null &
command! PR ProjectRefresh
command! EclimEnable call EnableEclim()
" Only enable eclim for filtypes listed here!
"autocmd FileType java EnableEclim

