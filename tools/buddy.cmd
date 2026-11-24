@echo off
rem BuddyLink A 端（Windows）启动器：把本文件所在目录加入 PATH，然后用 buddy.cmd auto "..."
"C:\Program Files\nodejs\node.exe" "%~dp0buddy" %*
