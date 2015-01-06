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

let g:EclimProjectProblemsUpdateOnSave=0
let g:EclimCValidate=0

function! MyEclimBuild()
    w
    ProjectBuild
    ProjectProblems!
    !start ctags -R --c++-kinds=+p --fields=+imaS --extra=+q --exclude=gmock --exclude=build --exclude=.moc
endfun

function! EVimPluginFeedKey(keys, refocus)
    let s:bufnr = bufnr("")
    if (s:bufnr != 1)
        1b!
    endif
    call eclim#vimplugin#FeedKeys(a:keys, a:refocus)
    if (s:bufnr != 1)
        b!#
    endif
endfun

function! EnableEclim()
    if exists("g:EclimDisabled")
        unlet g:EclimDisabled
        nmap ,em :call MyEclimBuild()<CR>
        nmap <F10> :call EVimPluginFeedKey("F10", 1)<CR>
        nmap <F11> :call EVimPluginFeedKey("F11", 1)<CR>
        nnoremap <silent> <buffer> <cr> :CSearchContext<cr>
        runtime! plugin/eclim.vim
        autocmd java BufWinEnter *.cpp,*.hpp,*.c,*.h call SuperTabSetDefaultCompletionType("<c-x><c-u>")
        call SuperTabSetDefaultCompletionType("<c-x><c-u>")
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
"let g:EclimEclipseHome = $HOME . '/src/eclipse'
let g:EclimTaglistEnabled = 0
let g:EclimShowCurrentError = 0

"command! EclimStart silent !eclipse &> /dev/null &
command! PR ProjectRefresh
command! EclimEnable call EnableEclim()
