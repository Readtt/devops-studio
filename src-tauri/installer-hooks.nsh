; "Open in DevOps Studio" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInDevOpsStudio" "" "Open in DevOps Studio"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInDevOpsStudio" "Icon" '"$INSTDIR\devops-studio.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInDevOpsStudio" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInDevOpsStudio\command" "" '"$INSTDIR\devops-studio.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInDevOpsStudio" "" "Open in DevOps Studio"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInDevOpsStudio" "Icon" '"$INSTDIR\devops-studio.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInDevOpsStudio" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInDevOpsStudio\command" "" '"$INSTDIR\devops-studio.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInDevOpsStudio" "" "Open in DevOps Studio"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInDevOpsStudio" "Icon" '"$INSTDIR\devops-studio.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInDevOpsStudio" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInDevOpsStudio\command" "" '"$INSTDIR\devops-studio.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInDevOpsStudio"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInDevOpsStudio"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInDevOpsStudio"
!macroend
