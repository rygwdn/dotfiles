
runtime plugin/fugitive.vim

if exists("g:loaded_fugitive")
    set statusline=%<%f%w\ %h%m%r\ %y\ \ %{fugitive#statusline()}%=%-14.(%l,%c%V%)\ %P
endif
