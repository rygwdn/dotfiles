" The ultimite snippet solution

command! UltiReset py UltiSnips_Manager.reset()
let g:ultisnips_python_style = "doxygen"
let g:ultisnips_java_brace_style = "nl"
let g:UltiSnipsUsePythonVersion = 2

if has('gui_running') || has('nvim')
    let g:UltiSnipsExpandTrigger='<C-Space>'
else
    let g:UltiSnipsExpandTrigger='<Nul>'
endif
