let g:Powerline_stl_path_style='short'
let g:airline#extensions#whitespace#enabled = 1

if has("gui_running")
    let g:airline_powerline_fonts = 1
endif

if index(keys(g:bundle_names), 'vim-airline') == -1 && has("gui_running")
    python <<EOF
import vim
try:
   from powerline.vim import setup as powerline_setup
   powerline_setup()
   del powerline_setup
   vim.command("set noshowmode")
except ImportError:
    vim.command('echom "Failed to import powerline, install with:"')
    vim.command('echom "pip install --user git+git://github.com/Lokaltog/powerline"')
    vim.command('echom "Also install pygit2, mercurial, psutil (see powerline docs)"')
EOF
endif
