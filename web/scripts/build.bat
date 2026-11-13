@echo off
rem Builds SDR++ with the web monitor and only the bladeRF and RTL-SDR source modules (MSVC + Ninja).
rem Usage: web\scripts\build.bat [extra cmake options]
rem Needs: Visual Studio Build Tools (C++), vcpkg with fftw3 glfw3 zstd (x64-windows),
rem        PothosSDR in C:\Program Files\PothosSDR (volk, rtlsdr), bladeRF in C:\Program Files\bladeRF.
rem Set VCPKG_ROOT to the vcpkg folder (default C:\dev\vcpkg) and BUILD_DIR to change the output folder.
setlocal
if not defined BUILD_DIR set "BUILD_DIR=build"
if not defined VCPKG_ROOT if exist "E:\vcpkg\vcpkg.exe" set "VCPKG_ROOT=E:\vcpkg"
if not defined VCPKG_ROOT set "VCPKG_ROOT=C:\dev\vcpkg"
if not exist "%VCPKG_ROOT%\scripts\buildsystems\vcpkg.cmake" (
  echo vcpkg not found in %VCPKG_ROOT%. Set VCPKG_ROOT.
  exit /b 1
)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
  echo Visual Studio Build Tools with the C++ workload were not found.
  exit /b 1
)
rem vcvars64 replaces VCPKG_ROOT with the copy bundled in Visual Studio, so keep ours aside
set "VCPKG_DIR=%VCPKG_ROOT%"
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0..\.."
cmake -S . -B "%BUILD_DIR%" -G Ninja -DCMAKE_BUILD_TYPE=Release ^
  "-DCMAKE_TOOLCHAIN_FILE=%VCPKG_DIR%\scripts\buildsystems\vcpkg.cmake" ^
  -DUSE_INTERNAL_LIBCORRECT=OFF -DOPT_BUILD_WEB_MONITOR=ON -DOPT_BUILD_ATV_DECODER=OFF -DOPT_BUILD_BLADERF_SOURCE=ON -DOPT_BUILD_RTL_SDR_SOURCE=ON ^
  -DOPT_BUILD_AIRSPY_SOURCE=OFF -DOPT_BUILD_AIRSPYHF_SOURCE=OFF -DOPT_BUILD_AUDIO_SOURCE=OFF ^
  -DOPT_BUILD_FILE_SOURCE=OFF -DOPT_BUILD_HACKRF_SOURCE=OFF -DOPT_BUILD_HERMES_SOURCE=OFF ^
  -DOPT_BUILD_NETWORK_SOURCE=OFF -DOPT_BUILD_PLUTOSDR_SOURCE=OFF -DOPT_BUILD_RFSPACE_SOURCE=OFF ^
  -DOPT_BUILD_RTL_TCP_SOURCE=OFF -DOPT_BUILD_SDRPP_SERVER_SOURCE=OFF -DOPT_BUILD_SPECTRAN_HTTP_SOURCE=OFF ^
  -DOPT_BUILD_SPYSERVER_SOURCE=OFF -DOPT_BUILD_AUDIO_SINK=OFF -DOPT_BUILD_NETWORK_SINK=OFF ^
  -DOPT_BUILD_METEOR_DEMODULATOR=OFF -DOPT_BUILD_PAGER_DECODER=OFF -DOPT_BUILD_RADIO=OFF ^
  -DOPT_BUILD_DISCORD_PRESENCE=OFF -DOPT_BUILD_FREQUENCY_MANAGER=OFF -DOPT_BUILD_IQ_EXPORTER=OFF ^
  -DOPT_BUILD_RECORDER=OFF -DOPT_BUILD_RIGCTL_CLIENT=OFF -DOPT_BUILD_RIGCTL_SERVER=OFF ^
  -DOPT_BUILD_SCANNER=OFF %* || exit /b 1
cmake --build "%BUILD_DIR%" || exit /b 1
echo.
echo Built. Put the modules into the root folder and start the monitor:
echo   copy %BUILD_DIR%\source_modules\bladerf_source\bladerf_source.dll root\modules\
echo   copy %BUILD_DIR%\source_modules\rtl_sdr_source\rtl_sdr_source.dll root\modules\
echo   %BUILD_DIR%\sdrpp.exe --web --port 8080 -r root
