; Smartcom Revisited NSIS customisations.
;
; electron-builder injects this file into its own installer template, so it must
; only define the documented custom* macros. Declaring raw Sections here (in
; particular `Section "Uninstall"`) collides with the generated uninstaller and
; fails the build with "WriteUninstaller never used".
;
; Shortcuts, Add/Remove Programs entries and app-data cleanup are already
; handled by the `nsis` options in package.json — the only thing left to do is
; register the smartcom:// URL protocol.

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\smartcom" "" "URL:Smartcom Revisited Protocol"
  WriteRegStr SHCTX "Software\Classes\smartcom" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\smartcom\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\smartcom\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\smartcom"
!macroend
