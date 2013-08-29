python << EOF
def SetupPathFromYCM():
    import ycm.completers.cpp.flags
    vim.current.buffer.options["path"] = ",".join(ycm.completers.cpp.flags.Flags().UserIncludePaths(vim.current.buffer.name))
EOF

command! SetupPathFromYCM python SetupPathFromYCM()
