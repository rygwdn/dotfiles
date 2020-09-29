:; if [ -z 0 ]; then
  @echo off
  goto :WINDOWS
fi

declare -a new_args
for arg in "$@"
do
    new_args+=("$(wslpath -u -- "$arg")")
done

exec vim "${new_args[@]}"

exit 99

:WINDOWS

@echo off
FOR /F "usebackq delims=" %%i IN (`wsl.exe wslpath -u "%0"`) DO wsl.exe -e bash %%i -- %*
exit /b %ERRORLEVEL%
