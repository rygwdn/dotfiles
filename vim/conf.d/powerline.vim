if index(keys(g:plugs), 'powerline') == -1
    finish
endif

let g:Powerline_stl_path_style='short'
let g:airline#extensions#whitespace#enabled = 1

if has("gui_running")
    let g:airline_powerline_fonts = 0
endif

set noshowmode
