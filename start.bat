@echo off
rem Fractal Nebulae - one-click launcher for Windows.
rem Checks Node.js, installs dependencies on the first run, starts the dev server on
rem http://localhost:5190 and opens it in your default browser as soon as it is ready.
rem (No parenthesised blocks below: a folder like "Program Files (x86)" would break them.)
setlocal
title Fractal Nebulae
set "PORT=5190"
set "URL=http://localhost:%PORT%/"

pushd "%~dp0"
if errorlevel 1 goto :nofolder

where node >nul 2>nul
if errorlevel 1 goto :nonode
where npm >nul 2>nul
if errorlevel 1 goto :nonode

rem Vite 8 needs Node.js ^20.19.0 or >=22.12.0.
set "NODEVER=unknown"
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)"
if errorlevel 1 goto :oldnode

rem npm writes node_modules\.package-lock.json only after an install has completed, so an
rem interrupted first install (some packages extracted, others missing) is installed again.
if exist "node_modules\.package-lock.json" if exist "node_modules\vite\package.json" if exist "node_modules\three\package.json" if exist "node_modules\tone\package.json" goto :depsok
echo Installing dependencies - first run only, needs an internet connection...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto :installfail
echo.
:depsok

rem The dev server uses a fixed port (strictPort). Is it free?
node -e "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(%PORT%,'localhost',()=>s.close(()=>process.exit(0)))"
if not errorlevel 1 goto :run
rem Busy: if it is Fractal Nebulae already running (e.g. start.bat opened twice), just show it.
node -e "fetch('%URL%',{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(t=>process.exit(t.includes('Fractal Nebulae')?0:1),()=>process.exit(1))"
if errorlevel 1 goto :portbusy
echo Fractal Nebulae is already running in another window - opening %URL%
start "" "%URL%"
goto :done

:run
echo Starting Fractal Nebulae at %URL%
echo Your browser opens by itself when the server is ready - use Chrome or Edge.
echo Keep this window open while you fly. Press Ctrl+C here to stop the server.
echo.
call npm run dev -- --open
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" goto :done
echo.
echo The dev server stopped (exit code %RC%).
echo If you did not stop it yourself, scroll up for the error message.
goto :fail

:nofolder
echo Could not open the folder that contains start.bat.
goto :fail

:nonode
echo Node.js was not found on this PC.
echo Install the LTS version from https://nodejs.org and run start.bat again.
echo If you have just installed it, close this window first so the new PATH is picked up.
goto :fail

:oldnode
echo This Node.js is too old for Vite 8: found %NODEVER%, need 20.19+ or 22.12+.
echo Install the current LTS version from https://nodejs.org and run start.bat again.
goto :fail

:installfail
echo.
echo "npm install" failed. Check your internet connection and the messages above, then try again.
goto :fail

:portbusy
echo Port %PORT% is already in use by another program, so Fractal Nebulae cannot start.
echo Close that program and run start.bat again. To see which process holds the port, run:
echo     netstat -ano ^| findstr :%PORT%
echo and look the PID up in Task Manager (Details tab).
goto :fail

:fail
echo.
pause
popd
endlocal
exit /b 1

:done
popd
endlocal
exit /b 0
