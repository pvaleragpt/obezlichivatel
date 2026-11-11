# Установка Обезличивателя на Windows: страница, ярлык, MCP-сервер для Claude Code и защитный хук.
# Запуск: двойной щелчок по install.cmd (или: powershell -ExecutionPolicy Bypass -File install.ps1).
# Права администратора не нужны: всё ставится в папку пользователя.
# Continue: pip и другие программы пишут предупреждения в stderr — это не повод прерывать установку.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:USERPROFILE 'obezlichivatel-mcp'
$Data = if ($env:OBEZL_HOME) { $env:OBEZL_HOME } else { Join-Path $env:USERPROFILE 'Обезличиватель' }

function Say($t)  { Write-Host ''; Write-Host $t -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  ✓ $t" -ForegroundColor Green }
function Skip($t) { Write-Host "  – $t" -ForegroundColor Yellow }
function SrcFile($name) {
    foreach ($p in @((Join-Path $Src "mcp\$name"), (Join-Path $Src $name))) { if (Test-Path $p) { return $p } }
    return $null
}

Say '1/8 Python'
$Py = $null
# Без двойных кавычек в коде: PowerShell 5.1 срезает их в аргументах программ.
$Probe = 'import sys; print(sys.executable) if sys.version_info >= (3, 8) else None'
foreach ($c in @('py -3', 'python', 'python3')) {
    $parts = $c -split ' '
    $extra = if ($parts.Count -gt 1) { $parts[1..($parts.Count - 1)] } else { @() }
    try {
        $exe = & $parts[0] @extra -c $Probe 2>$null | Select-Object -First 1
        if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { $Py = $exe.Trim(); break }
    } catch { }
}
if ($Py) {
    Ok (& $Py --version)
    $Pyw = Join-Path (Split-Path $Py) 'pythonw.exe'
    if (-not (Test-Path $Pyw)) { $Pyw = $Py }
} else {
    Skip 'Python 3.8+ не найден. Страница будет работать сама по себе (быстрая проверка правилами).'
    Skip 'Для нейросети, глубокой проверки и Claude Code установите Python с python.org (галочка «Add to PATH») и запустите установку снова.'
}

Say "2/7 Файлы → $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Page = Join-Path $Src 'dist\Обезличиватель.html'
if (-not (Test-Path $Page)) { $Page = Join-Path $Src 'Обезличиватель.html' }
foreach ($f in @('server.py', 'guard.py', 'ner_worker.py', 'llm.py', 'install_hook.py')) {
    $p = SrcFile $f
    if ($p) { Copy-Item $p $Dest -Force }
}
Copy-Item $Page (Join-Path $Dest 'Обезличиватель.html') -Force
$Icon = Join-Path $Src 'launcher\icon.ico'
if (Test-Path $Icon) { Copy-Item $Icon $Dest -Force; $Icon = Join-Path $Dest 'icon.ico' } else { $Icon = $null }
if (Test-Path (Join-Path $Src 'README.md')) { Copy-Item (Join-Path $Src 'README.md') $Dest -Force }
Ok 'сервер, хук и страница скопированы'

Say "3/7 Рабочие папки → $Data"
foreach ($d in @('Сырые', 'Обезличенные', 'С данными', '.ключи')) { New-Item -ItemType Directory -Force -Path (Join-Path $Data $d) | Out-Null }
$Keys = Get-Item (Join-Path $Data '.ключи') -Force
$Keys.Attributes = $Keys.Attributes -bor [IO.FileAttributes]::Hidden
Copy-Item (Join-Path $Dest 'Обезличиватель.html') (Join-Path $Data 'Обезличиватель.html') -Force
$Rules = Join-Path $Data 'правила.txt'
if (-not (Test-Path $Rules)) {
    [IO.File]::WriteAllText($Rules, "# Всегда скрывать: по одному на строку. Тип через двоеточие, шаблон — между косыми.`r`n# ШКОЛА: Лицей «Вектор»`r`n# /ДЛ-\d{6}/`r`n", [Text.UTF8Encoding]::new($false))
}
$Allow = Join-Path $Data 'не скрывать.txt'
if (-not (Test-Path $Allow)) {
    [IO.File]::WriteAllText($Allow, "# Никогда не скрывать: слова, похожие на имена, но не являющиеся ими.`r`n", [Text.UTF8Encoding]::new($false))
}
Ok 'Сырые, Обезличенные, С данными, .ключи'

Say '4/8 Claude Code'
$Claude = Get-Command claude -ErrorAction SilentlyContinue
if ($Py -and $Claude) {
    $Server = (Join-Path $Dest 'server.py') -replace '\\', '/'
    & claude mcp remove obezlichivatel -s user *> $null
    & claude mcp add obezlichivatel -s user -- ($Py -replace '\\', '/') -u $Server *> $null
    Ok 'MCP-сервер obezlichivatel добавлен'
} elseif (-not $Py) {
    Skip 'нужен Python — пропускаю'
} else {
    Skip 'Claude Code не найден — страница работает и без него'
}

Say '5/8 Защитный хук'
if ($Py) {
    & $Py (Join-Path $Dest 'install_hook.py') $Py (Join-Path $Dest 'guard.py')
} else {
    Skip 'нужен Python — пропускаю'
}

Say '6/8 Скилл для Claude Code'
$SkillSrc = Join-Path $Src 'skill\obezlichivatel\SKILL.md'
if (Test-Path $SkillSrc) {
    $SkillDir = Join-Path $env:USERPROFILE '.claude\skills\obezlichivatel'
    New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
    Copy-Item $SkillSrc (Join-Path $SkillDir 'SKILL.md') -Force
    Ok 'скилл obezlichivatel → .claude\skills\obezlichivatel (Claude сам обезличивает файлы с данными)'
} else {
    Skip 'файла скилла нет — пропускаю'
}

Say '7/8 Нейросеть Natasha'
$Venv = Join-Path $Dest '.venv'
$VPy = Join-Path $Venv 'Scripts\python.exe'
if (-not $Py) {
    Skip 'нужен Python — пропускаю'
} elseif ((Test-Path $VPy) -and $(& $VPy -c 'import natasha' 2>$null; $LASTEXITCODE -eq 0)) {
    Ok 'Natasha уже установлена'
} else {
    $a = Read-Host '  Установить Natasha — нейросеть для имён (около 100 МБ из интернета)? Enter — да, n — нет'
    if ($a -notmatch '^\s*(n|no|н|нет)') {
        try {
            & $Py -m venv $Venv
            & $VPy -m pip install -q --disable-pip-version-check natasha
            if ($LASTEXITCODE -eq 0) { Ok "Natasha установлена в $Venv" } else { Skip 'Natasha не установилась — работают правила и словарь' }
        } catch { Skip 'Natasha не установилась — работают правила и словарь' }
    } else {
        Skip 'пропущено. Установить позже — запустите установку снова'
    }
}

Say '8/8 Ярлык'
$Shell = New-Object -ComObject WScript.Shell
$Places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $Places) {
    $lnk = $Shell.CreateShortcut((Join-Path $dir 'Обезличиватель.lnk'))
    if ($Py) {
        $lnk.TargetPath = $Pyw
        $lnk.Arguments = '"' + (Join-Path $Dest 'server.py') + '" --app'
        $lnk.WorkingDirectory = $Dest
    } else {
        $lnk.TargetPath = Join-Path $Data 'Обезличиватель.html'
    }
    if ($Icon) { $lnk.IconLocation = $Icon }
    $lnk.Description = 'Скрывает персональные данные перед отправкой в Claude'
    $lnk.Save()
}
Ok 'ярлык «Обезличиватель» — на Рабочем столе и в меню «Пуск»'

Say 'Готово'
Write-Host '  • Откройте ярлык «Обезличиватель» — страница откроется в браузере.'
if ($Py -and $Claude) { Write-Host '  • В Claude Code перезапустите сессию и скажите: «Обезличь свежий файл из Сырых».' }
Write-Host "  • Файлы с данными кладите в $Data\Сырые — Claude их не прочитает."
Write-Host '  • Глубокая проверка: на странице выберите «Глубокая» → «Подключить» (Ollama и модель скачаются с ollama.com).'
Write-Host ''
Read-Host 'Нажмите Enter, чтобы закрыть'
