if did_filetype()	" filetype already set..
    finish		" ..don't do these checks
endif

" Detect confluencewiki
let s:lnum = 1
while s:lnum < 100 && s:lnum < line("$")
    if getline(s:lnum) =~ '^h[12345]\. '
        setf confluencewiki
        break
    endif
    let s:lnum += 1
endwhile

unlet s:lnum
