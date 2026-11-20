# Registers a hidden logon task "SecondBrain Gateway" that keeps gateway/server.mjs running.
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
if(-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))){throw 'Сначала выполните: npm run gateway:setup'}
if(-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))){throw 'Сначала выполните: npm run setup:gateway'}
$taskName='SecondBrain Gateway'
$powerShellPath=(Get-Command powershell.exe).Source
$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$run=Join-Path $root 'Run-Gateway.ps1'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and @($existing.Actions | Where-Object {$_.Arguments -notlike "*$run*"}).Count){throw 'Задача с таким именем уже занята другим скриптом'}
$action=New-ScheduledTaskAction -Execute $powerShellPath -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$run+'"') -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $account
$principal=New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'SecondBrain gateway for ChatGPT and Claude connectors (OAuth, read-only).' -Force
Start-ScheduledTask -TaskName $taskName
Write-Output 'SecondBrain Gateway: автозапуск установлен'
