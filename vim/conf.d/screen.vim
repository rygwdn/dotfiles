
autocmd BufEnter * let &titlestring = "vim[" . expand("%:t") . "]"
if &term == "screen"
    set t_ts=k
    set t_fs=\
endif

if &term == "screen" || &term == "xterm"
    set title
endif
