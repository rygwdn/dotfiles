if index(keys(g:plugs), 'YouCompleteMe') == -1
    finish
endif

python << EOF
def SetupPathFromYCM():
    try:
        import ycm.completers.cpp.flags
    except:
        pass
    else:
        flags = ycm.completers.cpp.flags.Flags()
        pathstr = ",".join(flags.UserIncludePaths(vim.current.buffer.name))
        vim.current.buffer.options["path"] = pathstr
EOF

command! SetupPathFromYCM python SetupPathFromYCM()
