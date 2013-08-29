let g:Powerline_stl_path_style='short'

if has("gui_running")
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
