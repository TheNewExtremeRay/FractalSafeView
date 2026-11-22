; SafeView Installer Script (v1.0.0)
; Location: nsis/installer.nsi
; Build the unpacked app first: npm run dist  (or build.bat)
; Then compile: makensis nsis/installer.nsi

!define APP_NAME "SafeView"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "Fractal"
!define APP_EXE "SafeView.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Icon "${__FILEDIR__}\..\assets\icon.ico"
!define MUI_ICON "${__FILEDIR__}\..\assets\icon.ico"
!define MUI_UNICON "${__FILEDIR__}\..\assets\icon.ico"

Name "${APP_NAME} v${APP_VERSION}"
OutFile "${__FILEDIR__}\${APP_NAME}-${APP_VERSION}-Setup.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "Install_Dir"

!include "MUI2.nsh"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; Copy the entire unpacked Electron app (built by electron-builder).
  File /r "${__FILEDIR__}\..\dist\win-unpacked\*.*"

  ; Versioned shortcut icon avoids stale Windows icon-cache entries.
  File /oname=${APP_NAME}-${APP_VERSION}.ico "${__FILEDIR__}\..\assets\icon.ico"

  SetOutPath "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_NAME}-${APP_VERSION}.ico" 0
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_NAME}-${APP_VERSION}.ico" 0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  WriteRegStr HKCU "Software\${APP_NAME}" "Install_Dir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME} v${APP_VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"
SectionEnd