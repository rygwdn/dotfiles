" LaTeX Box rubber functions


" <SID> Wrap {{{
function! s:GetSID()
	return matchstr(expand('<sfile>'), '\zs<SNR>\d\+_\ze.*$')
endfunction
let s:SID = s:GetSID()
function! s:SIDWrap(func)
	return s:SID . a:func
endfunction
" }}}


" dictionary of rubber PID's (basename: pid)
let s:rubber_running_pids = {}

" Set PID {{{
function! s:RubberSetPID(basename, pid)
	let s:rubber_running_pids[a:basename] = a:pid
endfunction
" }}}

" Callback {{{
function! s:RubberCallback(basename, status, tempfile)
	"let pos = getpos('.')
	if a:status
		echomsg "rubber exited with status " . a:status
	else
		echomsg "rubber finished"
	endif
	call remove(s:rubber_running_pids, a:basename)
	call LatexBox_RubberErrors(0, a:tempfile, a:basename)
	"call setpos('.', pos)
endfunction
" }}}

" Rubber {{{
function! LatexBox_Rubber(force)

	if empty(v:servername)
		echoerr "cannot run rubber in background without a VIM server"
		return
	endif

	let basename = LatexBox_GetTexBasename(1)

	if has_key(s:rubber_running_pids, basename)
		echomsg "rubber is already running for `" . fnamemodify(basename, ':t') . "'"
		return
	endif

	let callsetpid = s:SIDWrap('RubberSetPID')
	let callback = s:SIDWrap('RubberCallback')
	let l:tmpfile = tempname()

	let l:options = ''
	if a:force
		let l:options .= ' -g'
	endif

	" callback to set the pid
	let vimsetpid = g:vim_program . ' --servername ' . v:servername . ' --remote-expr ' .
				\ shellescape(callsetpid) . '\(\"' . basename . '\",$$\)'

	" rubber command
	let cmd = 'cd ' . LatexBox_GetTexRoot() . ' ; rubber ' . l:options . ' ' . LatexBox_GetMainTexFile() .
				\ ' &> ' . l:tmpfile

	" callback after rubber is finished
	let vimcmd = g:vim_program . ' --servername ' . v:servername . ' --remote-expr ' . 
				\ shellescape(callback) . '\(\"' . basename . '\",$?,\"' . l:tmpfile . '\"\)'

	silent execute '! ( ' . vimsetpid . ' ; ( ' . cmd . ' ) ; ' . vimcmd . ' ) &'
endfunction
" }}}

" RubberStop {{{
function! LatexBox_RubberStop()

	let basename = LatexBox_GetTexBasename(1)

	if !has_key(s:rubber_running_pids, basename)
		echomsg "rubber is not running for `" . fnamemodify(basename, ':t') . "'"
		return
	endif

	call s:kill_rubber(s:rubber_running_pids[basename])

	call remove(s:rubber_running_pids, basename)
	echomsg "rubber stopped for `" . fnamemodify(basename, ':t') . "'"
endfunction
" }}}

" kill_rubber {{{
function! s:kill_rubber(gpid)

	" This version doesn't work on systems on which pkill is not installed:
	"!silent execute '! pkill -g ' . pid

	" This version is more portable, but still doesn't work on Mac OS X:
	"!silent execute '! kill `ps -o pid= -g ' . pid . '`'

	" Since 'ps' behaves differently on different platforms, we must use brute force:
	" - list all processes in a temporary file
	" - match by process group ID
	" - kill matches
	let pids = []
	let tmpfile = tempname()
	silent execute '!ps x -o pgid,pid > ' . tmpfile
	for line in readfile(tmpfile)
		let pid = matchstr(line, '^\s*' . a:gpid . '\s\+\zs\d\+\ze')
		if !empty(pid)
			call add(pids, pid)
		endif
	endfor
	call delete(tmpfile)
	if !empty(pids)
		silent execute '! kill ' . join(pids)
	endif
endfunction
" }}}

" kill_all_rubber {{{
function! s:kill_all_rubber()
	for gpid in values(s:rubber_running_pids)
		call s:kill_rubber(gpid)
	endfor
	let s:rubber_running_pids = {}
endfunction
" }}}

" RubberClean {{{
function! LatexBox_RubberClean(cleanall)

	if a:cleanall
		let l:options = '--clean'
	else
		let l:options = '--clean'
	endif

	let l:cmd = 'cd ' . LatexBox_GetTexRoot() . ' ; rubber ' . l:options . ' ' . LatexBox_GetMainTexFile()

	silent execute '! ' . l:cmd
	echomsg "rubber clean finished"
endfunction
" }}}

" RubberStatus {{{
function! LatexBox_RubberStatus(detailed)

	if a:detailed
		if empty(s:rubber_running_pids)
			echo "rubber is not running"
		else
			let plist = ""
			for [basename, pid] in items(s:rubber_running_pids)
				if !empty(plist)
					let plist .= '; '
				endif
				let plist .= fnamemodify(basename, ':t') . ':' . pid
			endfor
			echo "rubber is running (" . plist . ")"
		endif
	else
		let basename = LatexBox_GetTexBasename(1)
		if has_key(s:rubber_running_pids, basename)
			echo "rubber is running"
		else
			echo "rubber is not running"
		endif
	endif

endfunction
" }}}

" RubberErrors {{{
" LatexBox_RubberErrors(jump, [basename])
function! LatexBox_RubberErrors(jump, tempfile, ...)
	if a:0 >= 1
		let basename = a:1
	else
		let basename = LatexBox_GetTexBasename(1)
	endif

	if (a:jump)
		execute "cfile " . a:tempfile
	else
		execute 'cgetfile ' . a:tempfile
	endif
endfunction
" }}}

" RubberInfo {{{
" LatexBox_RubberInfo(jump, [basename])
function! LatexBox_RubberInfo(jump, ...)
	if a:0 >= 1
		let basename = a:1
	else
		let basename = LatexBox_GetTexBasename(1)
	endif

	let l:cmd = "system('cd " . LatexBox_GetTexRoot() .
					\ "; rubber-info " . LatexBox_GetMainTexFile() .
					\ "')"
	if (a:jump)
		execute "cexpr " . l:cmd
	else
		execute 'cgetexpr ' . l:cmd
	endif
endfunction
" }}}

" Commands {{{
command! Rubber				call LatexBox_Rubber(0)
command! RubberForce			call LatexBox_Rubber(1)
command! RubberClean			call LatexBox_RubberClean(0)
command! RubberStatus			call LatexBox_RubberStatus(0)
command! RubberStatusDetailed	call LatexBox_RubberStatus(1)
command! RubberStop			call LatexBox_RubberStop()
command! RubberInfo			call LatexBox_RubberInfo(1)
" }}}

autocmd VimLeavePre * call <SID>kill_all_rubber()

" vim:fdm=marker:ff=unix:noet:ts=4:sw=4
