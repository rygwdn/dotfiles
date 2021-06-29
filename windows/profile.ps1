Set-PSReadlineKeyHandler -Key Tab -Function Complete
Set-PSReadlineKeyHandler -Key ctrl+d -Function ViExit
Set-PSReadlineOption -BellStyle Visual 

Set-Alias -Name yt -Value youtube-dl.exe

if ($env:WT_SESSION) {
  # Only use powerline theme in windows terminal, not standard terminal
  if (gcm Set-PoshPrompt -ErrorAction SilentlyContinue) {
    Set-PoshPrompt -Theme powerline
  }
}
