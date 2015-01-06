nmap ,gd :silent Git! diff %<CR>:echom "Write with :Gw or ,gw"<CR>
nmap ,gs :silent Gstatus<CR>
nmap ,ga :silent Git add %<CR>
nmap ,gw :silent Gwrite<CR>
nmap ,gn :call GitNext(0)<CR>
nmap ,gp :call GitNext(1)<CR>

function! GitNext(prev)
    let s:basedir = system("git rev-parse --show-toplevel 2>/dev/null")
    let s:basedir = substitute(s:basedir, "[\n\r]", "", "g")
    let s:thisfile = system("git ls-files --full-name " . shellescape(expand("%:p")) . " 2>/dev/null")
    let s:thisfile = substitute(s:thisfile, "[\n\r]", "", "g")
    let s:files = split(system("git status --porcelain | sed 's/^...//' | sort -u"), '[\n\r]')
    if a:prev == 1
        let s:files = reverse(s:files)
    endif
    for next in [0, 1]
        for file in s:files
            if next == 0 && file == s:thisfile
                let next = 1
            elseif next == 1
                let full_path = s:basedir . "/" . file
                call system("test -f " . fnameescape(full_path))
                if v:shell_error == 0
                    execute "edit" fnameescape(full_path)
                    return
                endif
            endif
        endfor
    endfor
endfunction
