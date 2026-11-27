# Windows toast for SecondBrain (2026-11-27). Called by the server (notifier.mjs) and by the supervisor.
# -Payload: base64 of UTF-8 JSON {title, body, url?, tag?, app?, verify?}. All text arrives in the payload, so this file
# stays ASCII and needs no BOM. The app identity "SecondBrain.Local" is registered per user (HKCU) with a display name
# and icon, so the toast shows as «Второй мозг» instead of Windows PowerShell.
param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$aumid = 'SecondBrain.Local'
$key = "HKCU:\Software\Classes\AppUserModelId\$aumid"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
if ($p.app) { Set-ItemProperty -Path $key -Name DisplayName -Value ([string]$p.app) }
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'public\notify-icon.png'
if (Test-Path $icon) { Set-ItemProperty -Path $key -Name IconUri -Value ((Resolve-Path $icon).Path) }

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
function Esc([string]$s) { [Security.SecurityElement]::Escape($s) }
$launch = ''
if ($p.url) { $launch = ' activationType="protocol" launch="' + (Esc $p.url) + '"' }
$xml = '<toast' + $launch + '><visual><binding template="ToastGeneric"><text>' + (Esc $p.title) + '</text><text>' + (Esc $p.body) + '</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
$toast.Group = 'secondbrain'
if ($p.tag) { $toast.Tag = ([string]$p.tag).Substring(0, [Math]::Min(16, ([string]$p.tag).Length)) }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
if ($p.verify) {
  Start-Sleep -Milliseconds 500
  $h = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid)
  Write-Output ('history=' + $h.Count)
}
