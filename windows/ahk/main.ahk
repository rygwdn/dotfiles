#NoEnv  ; Recommended for performance and compatibility with future AutoHotkey releases.
#SingleInstance force ; Only run a single instance of this script
#Warn  ; Enable warnings to assist with detecting common errors.
SendMode Input  ; Recommended for new scripts due to its superior speed and reliability.
SetWorkingDir %A_ScriptDir%  ; Ensures a consistent starting directory.
SetTitleMatchMode, 2 

GroupAdd, owindows, Outlook ahk_exe OUTLOOK.EXE
GroupAdd, owindows, OneNote ahk_class ApplicationFrameWindow
GroupAdd, owindows, ahk_exe Outlook for Office365.exe
GroupAdd, vswindows, ahk_exe devenv.exe
GroupAdd, fwindows, ahk_class MozillaWindowClass
GroupAdd, nwindows, ahk_exe Notion.exe


#s::WinActivate, Slack ahk_exe slack.exe
#o::GroupActivate, owindows, r
#v::GroupActivate, vswindows, r
#f::GroupActivate, fwindows, r
#n::GroupActivate, nwindows, r

; Capslock -> Esc
+Capslock::Capslock
Capslock::Esc
