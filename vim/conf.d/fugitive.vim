nmap ,gd :silent Git! diff %<CR>:echom "Write with :Gw or ,gw"<CR>
nmap ,gs :silent Gstatus<CR>
nmap ,ga :silent Git add %<CR>
nmap ,gw :silent Gwrite<CR>
nmap ,gn :call GitNext(0)<CR>
nmap ,gp :call GitNext(1)<CR>

function! GitNext(prev)
    let basedir = system("git rev-parse --show-toplevel 2>/dev/null")
    let basedir = substitute(basedir, "[\n\r]", "", "g")
    let thisfile = system("git ls-files --full-name " . shellescape(expand("%:p")) . " 2>/dev/null")
    let thisfile = substitute(thisfile, "[\n\r]", "", "g")
    let files = split(system("git status --porcelain | sed 's/^...//' | sort -u"), '[\n\r]')
    if a:prev == 1
        let files = reverse(files)
    endif
    for next in [0, 1]
        for file in files
            if next == 0 && file == thisfile
                let next = 1
            elseif next == 1
                let full_path = basedir . "/" . file
                call system("test -f " . fnameescape(full_path))
                if v:shell_error == 0
                    execute "edit" fnameescape(full_path)
                    return
                endif
            endif
        endfor
    endfor
endfunction
