function! LoadRope()
    if has('python')
        python << EOF
        import ropevim
EOF
    endif
endfunction

call LoadRope()
