@echo off
cd /d %~dp0

echo ======================
echo GitHub Deploy Basladi
echo ======================
git init

git branch -M main

git remote add origin https://github.com/ataguclu1/quizmt.git

git add -A

git commit -m "auto deploy %date% %time%"

git push -u origin main --force

echo ======================
echo Bitti
echo ======================
pause