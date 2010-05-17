function! LoadRope()
python << EOF
import vim
import os, sys
for path in vim.eval("&rtp").split(","):
    if os.path.isfile(os.path.join(path, "ropevim.py")):
        sys.path.append(path)
    for mod in ("rope", "ropemode"):
        if os.path.isfile(os.path.join(path, mod, mod, "__init__.py")):
            sys.path.append(os.path.join(path, mod))
        if os.path.isfile(os.path.join(path, mod, "__init__.py")):
            sys.path.append(path)
import ropevim
EOF
endfunction

if has('python')
    call LoadRope()
endif
