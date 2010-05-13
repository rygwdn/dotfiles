" File: py-test-switcher.vim
" Author: Marius Gedminas <marius@gedmin.as>
" Version: 0.2
" Last Modified: 2008-06-10
"
" Overview
" --------
" Vim script to help switch between code modules and unit test modules.
"
" Probably very specific to the way I work (Zope 3 style unit tests)
"
" Installation
" ------------
" Copy this file to $HOME/.vim/plugin directory
"
"
" Usage
" -----
"
" Map a key (e.g. Ctrl-F6) to :SwitchCodeAndTest.  Press it whenever you want
" to switch the current buffer between foo.py and the corresponding
" tests/test_foo.py.
"
" There are two other commands, :TestForTheOtherWindow, that opens the
" corresponding test file for the code currently visible in the next window
" (when you have a split view), and :OpenTestInOtherWindow which chanes the
" buffer in the other window to the test module for the current buffer.

if has('python')
    python import sys, os
    python sys.path.append(os.path.expanduser('~/.vim/plugin')) # XXX
    python import py_test_switcher # see py_test_switcher.py
endif

" Utility function: switch to buffer containing file or open a new buffer
function! SwitchToFile(name)
    let tmp = bufnr(a:name)
    if tmp == -1
	exe 'edit ' . a:name
    else
	exe 'edit #'. tmp
    endif
endf


" If you're editing /path/to/foo.py, open /path/to/tests/test_foo.py
function! SwitchCodeAndTest()
    if has('python')
        python py_test_switcher.switch_code_and_test(verbose=int(vim.eval('&verbose')))
        return
    endif
    if expand('%:p:h:t') == 'tests'
	let filename = substitute(expand('%:p'), "tests/test_", "", "")
	let package = fnamemodify(filename, ':h:t')
	let name = fnamemodify(filename, ':t:r')
	if !filereadable(filename) && package == name
	    let filename = fnamemodify(filename, ':h') . '/__init__.py'
	endif
	call SwitchToFile(filename)
    elseif match(expand('%:t'), "^test_") == 0
	let filename = substitute(expand('%:p'), "test_", "", "")
	call SwitchToFile(filename)
    else
        let filename = expand('%:t')
	if filename == '__init__.py'
	    let filename = expand('%:p:h:t') . '.py'
	endif
	let dir = expand('%:h') 
	let dir = dir == "" ? "" : dir . "/"
	let proper_test_fn = dir . 'tests/test_' . filename
	if filereadable(dir . 'tests.py') && !filereadable(proper_test_fn)
	    call SwitchToFile(dir . 'tests.py')
	elseif filereadable(dir . 'test_' . filename) && !filereadable(proper_test_fn)
	    call SwitchToFile(dir . 'test_' . filename)
	else
	    call SwitchToFile(proper_test_fn)
	endif
    endif
endf
command! SwitchCodeAndTest		call SwitchCodeAndTest()


function! OpenTestInOtherWindow()
    let bn = bufnr('%')
    wincmd p
    exe "buffer" . bn
    SwitchCodeAndTest
endf
command! OpenTestInOtherWindow		call OpenTestInOtherWindow()


function! TestForTheOtherWindow()
    wincmd p
    let bn = bufnr('%')
    wincmd p
    exe "buffer" . bn
    SwitchCodeAndTest
endf
command! TestForTheOtherWindow		call TestForTheOtherWindow()
