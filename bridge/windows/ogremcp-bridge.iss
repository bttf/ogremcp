; The Windows installer for the Ogre MCP bridge (docs/architecture.md §7
; Installer, docs/releases.md). Inno Setup 6.3 or later.
;
; It installs the bridge only, for the current user, into
; %LOCALAPPDATA%\Programs\Ogre MCP, without admin rights, so that self-update
; can replace the program in place (§7). It adds a Start menu shortcut and
; starts the bridge when it finishes. Start at login is the tray's setting
; (package autostart), and the bridge installs the addon itself, so the
; installer does neither. It is unsigned (§7 Signing, D6).
;
; scripts/windows-installer.ps1 compiles it and defines:
;   BridgeVersion  the version, such as 1.2.3
;   BridgeExe      the path of the Windows binary GoReleaser built
; The output is ogremcp-bridge_<version>_windows_amd64_setup.exe.

#ifndef BridgeVersion
  #error BridgeVersion is not defined. Build with scripts/windows-installer.ps1.
#endif
#ifndef BridgeExe
  #error BridgeExe is not defined. Build with scripts/windows-installer.ps1.
#endif

#define BridgeName "Ogre MCP"
#define BridgeExeName "ogremcp-bridge.exe"

[Setup]
; Windows knows the install by AppId. Never change it: an installer with
; another AppId installs a second copy instead of upgrading this one.
AppId={{3A3AEFAD-54AF-4502-BFC7-C00D175C9778}
AppName={#BridgeName}
AppVersion={#BridgeVersion}
AppPublisher=red pine software
AppPublisherURL=https://ogremcp.redpine.software
; Per user, without admin rights (§7). The folder is fixed, so the program
; always stays where the user can replace it.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#BridgeName}
DisableDirPage=yes
DisableProgramGroupPage=yes
; The bridge is built for amd64 only. Windows 10 is the oldest version it
; supports (§7).
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; An upgrade closes a running bridge before it replaces the program. force
; ends the bridge when it does not close on request. Its adapter updates are
; crash-safe (§7).
CloseApplications=force
OutputBaseFilename=ogremcp-bridge_{#BridgeVersion}_windows_amd64_setup
WizardStyle=modern

[Files]
Source: "{#BridgeExe}"; DestDir: "{app}"; DestName: "{#BridgeExeName}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#BridgeName}"; Filename: "{app}\{#BridgeExeName}"

[Run]
Filename: "{app}\{#BridgeExeName}"; Description: "{cm:LaunchProgram,{#BridgeName}}"; Flags: nowait postinstall skipifsilent

; The uninstaller does not close running programs, so it ends the bridge
; first. Otherwise Windows keeps the running program from being removed. It
; ends only a bridge whose program is in the install folder, which is the
; working folder here, so the folder's path needs no quoting. Another user's
; bridge, or a bridge run from anywhere else, keeps running.
[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -Command ""Get-Process -Name ogremcp-bridge -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -and (Split-Path -Parent $_.Path) -eq (Get-Location).Path } | Stop-Process -Force"""; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "StopBridge"

; What a self-update leaves beside the program until the bridge next starts:
; the new program before it is moved into place, and the old one after
; (RED-343, selfupdate.stagePrefix).
[UninstallDelete]
Type: files; Name: "{app}\.ogremcp-update-*"

; The tray's start-at-login value (package autostart, RunValueName). The
; installer does not write it. ValueType none with dontcreatekey only records
; it for the uninstaller, which removes it, so Windows does not try to start
; a removed program at login.
[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "OgreMCP"; Flags: dontcreatekey uninsdeletevalue
