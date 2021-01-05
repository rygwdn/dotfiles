Set-PSReadlineKeyHandler -Key Tab -Function Complete
Set-PSReadlineKeyHandler -Key ctrl+d -Function ViExit
Set-PSReadlineOption -BellStyle None 
Set-Alias -Name yt -Value youtube-dl.exe
