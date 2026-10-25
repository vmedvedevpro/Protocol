; Protocol — NSIS installer dependency hooks
; Tauri copies bundle.resources flat under $INSTDIR (e.g. $INSTDIR\runtime-deps\).
; The NSIS stub is 32-bit: use Sysnative / disable WOW64 redirection for 64-bit tools.
;
; The same installer is the Windows download and the in-app updater's payload
; (run with /P /UPDATE), so these hooks run again on every update.

!include "LogicLib.nsh"
!include "x64.nsh"

Var MeetilyBackend

; An explicit /BACKEND=vulkan|cpu is saved under ${MANUPRODUCTKEY} (HKCU) and
; reused by later installs and updates without the option. Otherwise the next
; update would run the probe again and reselect a Vulkan build the user left
; because it crashed (a driver can pass the probe and still fail in inference).
; /BACKEND=auto clears the saved choice.
!define PROTOCOL_BACKEND_VALUE "BackendOverride"

!macro Meetily_CheckVcredist
  StrCpy $R9 0
  SetRegView 64
  ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    StrCpy $R9 1
  ${Else}
    ReadRegDword $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
  ${If} $R9 == 0
    ReadRegDword $0 HKLM "SOFTWARE\Microsoft\VisualStudio\2022\VC\Runtimes\x64" "Installed"
    ${If} $0 == 1
      StrCpy $R9 1
    ${EndIf}
  ${EndIf}
  SetRegView lastused
!macroend

; A failure stops a first install. An update only warns: the files are already
; replaced and the previous version ran with the runtime it found, so aborting
; would leave a half-updated install behind the updater's passive window.
!macro Meetily_InstallVcredist
  ; Bundled next to other runtime-deps (NOT under resources\)
  StrCpy $R0 "$INSTDIR\runtime-deps\vc_redist.x64.exe"
  ${If} ${FileExists} "$R0"
    DetailPrint "      Running VC++ redistributable setup…"
    nsExec::ExecToLog '"$R0" /install /quiet /norestart'
    Pop $0
    DetailPrint "      VC++ installer exit code: $0"
    ${If} $0 != 0
    ${AndIf} $0 != 1638
    ${AndIf} $0 != 3010
      ${If} $UpdateMode = 1
        DetailPrint "      WARNING: Visual C++ Runtime setup failed (code $0); keeping the installed runtime."
      ${Else}
        MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ Runtime installation failed (code $0). Protocol setup cannot continue." /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
  ${ElseIf} $UpdateMode = 1
    DetailPrint "      WARNING: the Visual C++ Runtime package is missing from this update."
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "The Microsoft Visual C++ Runtime package is missing. Protocol setup cannot continue." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro Meetily_InstallCommonRuntime
  ; Installers before 0.3.0 copied the CUDA runtime (about 500 MB) next to
  ; protocol.exe. Nothing loads it any more, and an install over such a copy
  ; would otherwise keep it forever.
  Delete "$INSTDIR\cudart64_13.dll"
  Delete "$INSTDIR\cublas64_13.dll"
  Delete "$INSTDIR\cublasLt64_13.dll"
  StrCpy $R1 "$INSTDIR\runtime-deps"
  ${If} ${FileExists} "$R1\DirectML.dll"
    CopyFiles /SILENT "$R1\DirectML.dll" "$INSTDIR\"
    DetailPrint "      DirectML / ONNX runtime installed."
  ${Else}
    DetailPrint "      WARNING: DirectML.dll missing from bundle."
  ${EndIf}
!macroend

; Sets $R6=1 when the 64-bit Vulkan loader can reach a usable physical device.
; The native x64 probe follows the loader's modern DCH discovery and rejects
; stale loaders with no physical device. The legacy registry scan is retained
; only as a compatibility fallback for packages that predate the probe.
!macro Meetily_CheckVulkan
  StrCpy $R6 0
  ${DisableX64FSRedirection}
  ${If} ${FileExists} "$WINDIR\System32\vulkan-1.dll"
    StrCpy $R6 1
  ${ElseIf} ${FileExists} "$WINDIR\Sysnative\vulkan-1.dll"
    StrCpy $R6 1
  ${EndIf}
  ${If} $R6 == 1
    StrCpy $R6 0
    StrCpy $R4 "$INSTDIR\installer-variants\protocol-vulkan-probe.exe"
    ${If} ${FileExists} "$R4"
      nsExec::ExecToStack /TIMEOUT=15000 '"$R4"'
      Pop $R3
      Pop $R2
      ${If} $R3 == 0
        StrCpy $R6 1
      ${Else}
        DetailPrint "      Vulkan probe found no usable device (code $R3)."
      ${EndIf}
    ${Else}
      DetailPrint "      Vulkan capability probe is missing; checking legacy drivers."
      StrCpy $R5 0
      SetRegView 64
      ${Do}
        EnumRegValue $R4 HKLM "SOFTWARE\Khronos\Vulkan\Drivers" $R5
        ${If} $R4 == ""
          ${ExitDo}
        ${EndIf}
        ReadRegDword $R3 HKLM "SOFTWARE\Khronos\Vulkan\Drivers" "$R4"
        ${If} $R3 == 0
        ${AndIf} ${FileExists} "$R4"
          StrCpy $R6 1
        ${EndIf}
        IntOp $R5 $R5 + 1
      ${LoopUntil} $R6 == 1
      SetRegView lastused
    ${EndIf}
  ${EndIf}
  ${EnableX64FSRedirection}
!macroend

; Pick the canonical protocol.exe. The bundled main executable is the CPU
; build; only a Vulkan selection replaces it. Optional command-line override:
;   /BACKEND=vulkan | /BACKEND=cpu   (saved for later installs and updates)
;   /BACKEND=auto                    (clears the saved choice)
!macro Meetily_SelectBackend
  StrCpy $MeetilyBackend ""
  StrCpy $R0 ""
  ClearErrors
  ${GetOptions} $CMDLINE "/BACKEND=" $R0
  ${If} ${Errors}
    StrCpy $R0 ""
  ${EndIf}

  ; A standard Tauri bundle has no variant set. Keep its compiled executable
  ; instead of accidentally consuming stale local variant files.
  ${IfNot} ${FileExists} "$INSTDIR\installer-variants\universal.marker"
    StrCpy $MeetilyBackend "bundled"
    DetailPrint "      Standard bundle detected — keeping bundled executable."
  ${Else}
    ${If} $R0 == "auto"
      DeleteRegValue HKCU "${MANUPRODUCTKEY}" "${PROTOCOL_BACKEND_VALUE}"
      DetailPrint "      Cleared the saved backend choice."
      StrCpy $R0 ""
    ${ElseIf} $R0 == "vulkan"
    ${OrIf} $R0 == "cpu"
      WriteRegStr HKCU "${MANUPRODUCTKEY}" "${PROTOCOL_BACKEND_VALUE}" "$R0"
      DetailPrint "      Saved backend choice: $R0"
    ${ElseIf} $R0 != ""
      DetailPrint "      Unknown backend override — using CPU for this install."
      StrCpy $R0 "cpu"
    ${Else}
      ReadRegStr $R0 HKCU "${MANUPRODUCTKEY}" "${PROTOCOL_BACKEND_VALUE}"
      ${If} $R0 == "vulkan"
      ${OrIf} $R0 == "cpu"
        DetailPrint "      Using the saved backend choice: $R0"
      ${Else}
        StrCpy $R0 ""
      ${EndIf}
    ${EndIf}

    ${If} $R0 == "cpu"
      StrCpy $MeetilyBackend "cpu"
    ${Else}
      ; Automatic choice and an explicit Vulkan request both need a usable device.
      !insertmacro Meetily_CheckVulkan
      ${If} $R6 == 1
        StrCpy $MeetilyBackend "vulkan"
      ${Else}
        ${If} $R0 == "vulkan"
          DetailPrint "      Vulkan override unavailable — falling back to CPU."
        ${EndIf}
        StrCpy $MeetilyBackend "cpu"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $MeetilyBackend == "vulkan"
    StrCpy $R5 "$INSTDIR\installer-variants\protocol-vulkan.exe"
    ${IfNot} ${FileExists} "$R5"
      DetailPrint "      Vulkan build missing — keeping the CPU build."
      StrCpy $MeetilyBackend "cpu"
    ${Else}
      CopyFiles /SILENT "$R5" "$INSTDIR\protocol.selected.exe"
      ${If} ${FileExists} "$INSTDIR\protocol.selected.exe"
        Delete "$INSTDIR\${MAINBINARYNAME}.exe"
        Rename "$INSTDIR\protocol.selected.exe" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${Else}
        DetailPrint "      Backend replacement failed — keeping the CPU build."
        StrCpy $MeetilyBackend "cpu"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  DetailPrint "      Selected transcription backend: $MeetilyBackend"

  CreateDirectory "$INSTDIR\data"
  FileOpen $R4 "$INSTDIR\data\selected-backend.txt" w
  FileWrite $R4 "$MeetilyBackend$\r$\n"
  FileClose $R4

  RMDir /r "$INSTDIR\installer-variants"
!macroend

!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint both
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Protocol"
  ${If} $UpdateMode == 1
    DetailPrint " Updating app files…"
  ${Else}
    DetailPrint " Installing app files…"
  ${EndIf}
  DetailPrint "────────────────────────────────────────"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetDetailsPrint both
  DetailPrint ""
  DetailPrint "────────────────────────────────────────"
  DetailPrint " Runtime setup"
  DetailPrint "────────────────────────────────────────"

  DetailPrint "[1/3] Visual C++ 2015–2022 (x64)…"
  !insertmacro Meetily_CheckVcredist
  ${If} $R9 == 0
    DetailPrint "      Not found — installing quietly…"
    !insertmacro Meetily_InstallVcredist
  ${Else}
    DetailPrint "      Already installed — skipped."
  ${EndIf}

  DetailPrint "[2/3] Common local AI runtime…"
  !insertmacro Meetily_InstallCommonRuntime

  DetailPrint "[3/3] Selecting Vulkan or CPU…"
  !insertmacro Meetily_SelectBackend
  ${If} $MeetilyBackend == "vulkan"
    DetailPrint "      Vulkan enabled (AMD / Intel / NVIDIA)."
  ${ElseIf} $MeetilyBackend == "cpu"
    DetailPrint "      CPU mode enabled — maximum compatibility."
  ${EndIf}

  DetailPrint ""
  DetailPrint "Runtime setup finished."
  DetailPrint "────────────────────────────────────────"
!macroend

; Stops processes started from this install's own executable, without asking.
; The macro matches the full image path, not the image name, so it skips other
; programs with the same file name, a Protocol dev build, and another Protocol
; install (Labs). NSIS_HOOK_PREUNINSTALL runs it before Tauri's
; CheckIfAppIsRunning (installer.nsi). Since tauri-bundler 2.10 that check is
; path-based too (Restart Manager, this install's executable only), so in
; uninstall it normally finds nothing left: even an interactive uninstall
; terminates a running Protocol here, with no prompt and no end-session request.
; The 32-bit stub reads a 64-bit process's path through
; QueryFullProcessImageNameW, which needs only limited query access.
!macro Protocol_StopInstalledApp
  StrCpy $R1 "$INSTDIR\${MAINBINARYNAME}.exe"
  ; TH32CS_SNAPPROCESS
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.R2'
  ${If} $R2 P<> -1
    ; PROCESSENTRY32W; &l4 fills dwSize with the structure size.
    System::Call '*(&l4, i, i, p, i, i, i, i, i, &w260) p.R3'
    System::Call 'kernel32::Process32FirstW(p R2, p R3) i.R4'
    ${DoWhile} $R4 <> 0
      System::Call '*$R3(i, i, i .R5, p, i, i, i, i, i, &w260 .R6)'
      ${If} $R6 == "${MAINBINARYNAME}.exe"
        ; PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        System::Call 'kernel32::OpenProcess(i 0x101001, i 0, i R5) p.R7'
        ${If} $R7 P<> 0
          System::Call 'kernel32::QueryFullProcessImageNameW(p R7, i 0, w .R8, *i ${NSIS_MAX_STRLEN}) i.R9'
          ${If} $R9 <> 0
          ${AndIf} $R8 == $R1
            DetailPrint "      Stopping $R8 (process $R5)."
            System::Call 'kernel32::TerminateProcess(p R7, i 1)'
            ; Wait so the uninstaller can delete the executable and sidecars.
            System::Call 'kernel32::WaitForSingleObject(p R7, i 5000)'
          ${EndIf}
          System::Call 'kernel32::CloseHandle(p R7)'
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::Process32NextW(p R2, p R3) i.R4'
    ${Loop}
    System::Free $R3
    System::Call 'kernel32::CloseHandle(p R2)'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping Protocol if it is still running…"
  !insertmacro Protocol_StopInstalledApp
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Installs default to %LOCALAPPDATA%\<publisher>\<product> (installer.nsi).
  ; RMDir without /r removes the publisher folder only once it is empty.
  RMDir "$LOCALAPPDATA\${MANUFACTURER}"
  DetailPrint "Protocol was removed from this user profile."
!macroend
