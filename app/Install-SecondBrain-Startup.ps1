$ErrorActionPreference='Stop'
$appRoot=$PSScriptRoot
$taskName='SecondBrain Local Service'
$powerShellPath=(Get-Command powershell.exe).Source
$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$run=Join-Path $appRoot 'Run-SecondBrain.ps1'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and @($existing.Actions | Where-Object {$_.Arguments -notlike "*$run*"}).Count){throw 'A different task already occupies this name'}
$action=New-ScheduledTaskAction -Execute $powerShellPath -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$run+'"') -WorkingDirectory $appRoot
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $account
$principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'SecondBrain local background process; no reminders or Codex chats. Restarts the local server after exit.' -Force
Start-ScheduledTask -TaskName $taskName
Write-Output 'SecondBrain background startup installed'
