"Use my rope stuff
autocmd FileType python set omnifunc=RopeCompleteFunc

let ropevim_codeassist_maxfixes=10
let ropevim_vim_completion=1
let ropevim_extended_complete=1
let ropevim_guess_project=1
let ropevim_local_prefix="<LocalLeader>r"
let ropevim_global_prefix="<LocalLeader>p"
au FileType python map <buffer> ,r :RopeRename<CR>
"let ropevim_enable_shortcuts=0

if has('python')
python << EOF
import sys, os
for path in ("", "/rope", "/ropemode"):
    sys.path.append(os.path.expanduser('~/.vim/manual/ropevim' + path)) # XXX
EOF
endif
"let ropevim_enable_autoimport=0

