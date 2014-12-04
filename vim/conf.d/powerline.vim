if index(keys(g:bundle_names), 'powerline') == -1
    finish
endif

let g:Powerline_stl_path_style='short'
let g:airline#extensions#whitespace#enabled = 1

if has("gui_running")
    let g:airline_powerline_fonts = 1
endif

set noshowmode
