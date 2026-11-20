# Удалённый доступ: Tailscale и VPS в России

По умолчанию SecondBrain доступен только на том компьютере, где запущен (`127.0.0.1:8877`). Этого
хватает, если нейросети работают на нём же: Claude Code, Codex, Cursor.

| Что нужно | Что делать |
|---|---|
| Всё на одном компьютере | Ничего. Tailscale не нужен. |
| Панель и MCP с ноутбука или телефона, компьютер с базой включён | **Вариант A**: Tailscale на этом компьютере |
| База работает круглосуточно, без вашего компьютера | **Вариант B**: VPS |
| Подключить ChatGPT или claude.ai (сайт, приложения) | Шлюз `gateway/` через Tailscale Funnel: шаг 7 в [START_HERE.md](../START_HERE.md). На VPS — раздел B10 ниже. |

> **Главное правило.** Никогда не открывайте SecondBrain в интернет без пароля: в базе вся ваша
> переписка. Не делайте `tailscale funnel` на порт 8877 и не открывайте 8877 в файрволе.
> В интернет можно выпускать только шлюз (порт 8787): он требует OAuth и подтверждения владельца
> и умеет только искать и читать. Порт управления шлюзом 8788 не публикуйте никогда.

Сервер проверяет заголовки `Host` и `Origin` и отклоняет чужие адреса. Чтобы он принимал ваш адрес
(Tailscale или домен), этот адрес нужно указать в переменной **`BRAIN_PUBLIC_ORIGIN`**. Сам сервер
всё равно слушает только `127.0.0.1`.

---

## Вариант A. Tailscale: доступ к своему компьютеру со своих устройств

Tailscale — бесплатная частная сеть между вашими устройствами. Адрес будет виден только вашим
устройствам в этой сети, в интернет он не выходит.

1. Установите Tailscale на компьютер с SecondBrain и на ноутбук или телефон, войдите в один аккаунт:
   ```powershell
   winget install Tailscale.Tailscale
   ```
2. На компьютере с SecondBrain включите HTTPS-адрес внутри сети. Это `serve`, **не** `funnel`.
   Порт 8443 выбран, чтобы не мешать шлюзу для ChatGPT/Claude: он занимает публичный 443.
   ```powershell
   tailscale serve --bg --https=8443 8877
   tailscale serve status        # покажет адрес вида https://my-pc.tail1234.ts.net:8443
   ```
   Если команда попросит включить HTTPS для сети, перейдите по ссылке и включите.
3. Разрешите этот адрес в SecondBrain и перезапустите службу:
   ```powershell
   [Environment]::SetEnvironmentVariable('BRAIN_PUBLIC_ORIGIN','https://my-pc.tail1234.ts.net:8443','User')
   Stop-ScheduledTask 'SecondBrain Local Service'; Start-ScheduledTask 'SecondBrain Local Service'
   ```
   Если служба не установлена: закройте окно `npm start` и запустите его в **новом** терминале.
4. Проверка с другого устройства в сети: откройте `https://my-pc.tail1234.ts.net:8443`, панель должна загрузиться.
5. MCP на ноутбуке:
   ```powershell
   claude mcp add --transport http --scope user secondbrain https://my-pc.tail1234.ts.net:8443/mcp
   ```

Всё работает, пока компьютер с базой включён.

---

## Вариант B. VPS в России

### Что важно знать заранее

- **Модель для карточек.** OpenAI и Anthropic не принимают запросы и оплату из России, поэтому с
  российского VPS их API напрямую не заработает. Варианты:
  - российский сервис-агрегатор с **OpenAI-совместимым API** и оплатой российской картой;
  - Yandex Cloud или GigaChat, если у них есть OpenAI-совместимый режим;
  - вообще без модели: поиск, импорт и MCP работают и так.

  Обработчику карточек нужна поддержка **Structured Outputs** (`response_format: json_schema`).
  Проверьте это одной ручной обработкой в разделе «Обработка», прежде чем включать автоматическую.
- **Codex и Claude Code пишут сессии на вашем компьютере, а не на VPS.** Чтобы они попадали в базу,
  папки нужно синхронизировать на сервер, например через Syncthing (шаг 7). Заметки Obsidian — так же.
- **Почта** (IMAP Gmail и Яндекс) и **импорт выгрузок** ChatGPT и Claude работают прямо с VPS.
- **Автосбор чатов ChatGPT и Claude из аккаунта** открывает окно входа (Electron), а на сервере нет
  экрана. Варианты: держать сбор на своём компьютере (там же, где установлен SecondBrain, и
  периодически переносить базу) или раз в неделю загружать официальную выгрузку на сервер
  (`npm run import`). К тому же ChatGPT и Claude часто не пускают вход с российских IP.
- **Данные лежат на чужом сервере.** У хостинга есть физический доступ к диску. Выбирайте провайдера,
  которому доверяете. Включите вход по SSH-ключу и отключите вход по паролю.
- Автозапуск через `.ps1` в Windows на Linux не нужен, вместо него служба systemd из `deploy/`.

### Сервер

Ubuntu 24.04, 1–2 vCPU, 2 ГБ RAM, диск от 20 ГБ (база с вложениями может весить несколько гигабайт).

### 1. Пользователь и пакеты

```bash
sudo adduser --disabled-password --gecos "" brain
sudo apt update && sudo apt install -y git python3 python3-pip curl ufw
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # v24 или новее
```

### 2. Приложение

```bash
sudo -iu brain
git clone <адрес этого репозитория на GitHub> SecondBrain
cd SecondBrain
npm run setup && npm test && npm run check     # ждём «ℹ fail 0» и «ИТОГ: всё работает»
python3 -m pip install --user pypdf            # необязательно: текст PDF-вложений
exit
```

### 3. Служба

```bash
sudo cp /home/brain/SecondBrain/deploy/secondbrain.service /etc/systemd/system/
sudo nano /etc/systemd/system/secondbrain.service    # BRAIN_PUBLIC_ORIGIN = ваш адрес из шага 4
sudo systemctl daemon-reload && sudo systemctl enable --now secondbrain
curl -s http://127.0.0.1:8877/api/stats | head -c 80     # {"app":"secondbrain-local-v1",…
```

Если служба не стартует, посмотрите `journalctl -u secondbrain -n 50`. Если мешают строки ограничений
(`ProtectSystem`, `ProtectHome`, `BindPaths`), закомментируйте их.

### 4. Доступ: выберите один способ

**B1. Tailscale (рекомендуется: без домена, без открытых портов).**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                      # войти в тот же аккаунт, что на ваших устройствах
sudo tailscale serve --bg --https=8443 8877
tailscale serve status                 # адрес вида https://vps.tail1234.ts.net:8443 → в BRAIN_PUBLIC_ORIGIN
sudo ufw allow OpenSSH && sudo ufw enable
```

Пароль не нужен: адрес доступен только вашим устройствам в сети Tailscale.

**B2. Свой домен + Caddy + пароль (если Tailscale недоступен).**

```bash
sudo apt install -y caddy
caddy hash-password                    # придумайте пароль, скопируйте хеш
sudo cp /home/brain/SecondBrain/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile         # домен и хеш
sudo systemctl reload caddy
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Домен должен указывать на IP сервера (A-запись). Caddy сам получит сертификат. В `BRAIN_PUBLIC_ORIGIN`
укажите `https://ваш-домен`. Порт 8877 **не открывайте**.

После смены `BRAIN_PUBLIC_ORIGIN`: `sudo systemctl daemon-reload && sudo systemctl restart secondbrain`.

### 5. Подключить нейросети

B1 (Tailscale):
```bash
claude mcp add --transport http --scope user secondbrain https://vps.tail1234.ts.net:8443/mcp
```

B2 (домен с паролем): клиенту нужен заголовок авторизации. Значение — `Basic` и base64 от `логин:пароль`.
В PowerShell его можно получить так: `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('me:пароль'))`.
```bash
claude mcp add --transport http --scope user secondbrain https://brain.example.ru/mcp --header "Authorization: Basic <base64>"
```
В других клиентах добавьте тот же заголовок `Authorization` в настройку MCP-сервера.

### 6. Перенести уже собранную базу с компьютера (если есть)

На компьютере остановите службу (`Stop-ScheduledTask 'SecondBrain Local Service'`) и скопируйте папку
`store` целиком:

```powershell
scp -r .\store brain@<IP-сервера>:/home/brain/SecondBrain/
```

На сервере: `sudo chown -R brain:brain /home/brain/SecondBrain/store && sudo systemctl restart secondbrain`.
Ключ модели и пароли почты лежат в `store/secrets/` и переедут вместе с папкой. После переноса не
запускайте сервер на обоих компьютерах с одной и той же базой.

### 7. Сессии Codex, Claude Code и заметки → на сервер (Syncthing)

1. Поставьте Syncthing на компьютер (`winget install Syncthing.Syncthing`) и на сервер
   (`sudo apt install syncthing`, затем `sudo systemctl enable --now syncthing@brain`).
2. Свяжите устройства. Панель Syncthing на сервере открывайте через SSH-туннель:
   `ssh -L 8384:127.0.0.1:8384 brain@<IP>` и в браузере `http://127.0.0.1:8384`.
3. Расшарьте с компьютера в режиме «Только отправка»:

| Папка на компьютере | Папка на сервере |
|---|---|
| `%USERPROFILE%\.codex\sessions` | `/home/brain/.codex/sessions` |
| `%USERPROFILE%\.claude\projects` | `/home/brain/.claude/projects` |
| папка Obsidian | `/home/brain/notes` |

SecondBrain на сервере сам читает `~/.codex` и `~/.claude/projects` пользователя `brain`, а папку
заметок берёт из `BRAIN_OBSIDIAN_ROOT` (её можно сменить в панели: «Источники» → «Папки источника»).
Новое попадает в базу в течение 15 минут после синхронизации.

### 8. Резервные копии

```bash
sudo -iu brain crontab -e
# каждый день в 04:00 — копия базы, хранится 14 дней:
0 4 * * * cd /home/brain/SecondBrain && node app/tools/backup-db.mjs store/brain.sqlite backups/brain-$(date +\%F).sqlite && find backups -name 'brain-*.sqlite' -mtime +14 -delete
```

Вложения лежат в `store/assets/`, их копируйте отдельно (например, `rsync` на другой диск или сервер).

### 9. Обновление

```bash
sudo -iu brain bash -c 'cd SecondBrain && git pull && npm run setup && npm test'
sudo systemctl restart secondbrain
```

### 10. ChatGPT и claude.ai → база на VPS (шлюз)

Шлюзу нужен публичный HTTPS-адрес: ChatGPT и Claude ходят к нему из интернета.

С Tailscale (вариант B1):
```bash
sudo -iu brain bash -c 'cd SecondBrain && npm run setup:gateway && npm run check:gateway && npm run gateway:setup'
sudo tailscale funnel --bg 8787        # публичным становится только шлюз; панель 8877 остаётся в частной сети
```

Со своим доменом (вариант B2): отдельный поддомен для шлюза, **без** `basic_auth`, потому что шлюз
защищён OAuth. Пример — второй блок в `deploy/Caddyfile.example`.
```bash
sudo -iu brain bash -c 'cd SecondBrain && npm run setup:gateway && npm run check:gateway && npm run gateway:setup -- https://mcp.example.ru'
```

Служба шлюза:
```bash
sudo cp /home/brain/SecondBrain/deploy/secondbrain-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now secondbrain-gateway
```

Подключите коннектор в ChatGPT или Claude (адрес `https://<адрес шлюза>/mcp`) и подтвердите по SSH:
```bash
sudo -iu brain bash -c 'cd SecondBrain && npm run gateway:approve'
```

> Сервисы ChatGPT и Claude обращаются к шлюзу со своих серверов. Если провайдер VPS или сеть блокирует
> такие входящие подключения, коннектор не заработает. Проверьте адрес `/healthz` с телефона через
> мобильный интернет.

---

## Проверка безопасности

- [ ] Порт 8877 закрыт снаружи (`sudo ufw status` — 8877 нет в списке).
- [ ] Адрес открывается только через Tailscale или с паролем Caddy.
- [ ] `tailscale funnel status` показывает только порт 8787 (шлюз), не 8877 и не 8788.
- [ ] SSH только по ключу.
- [ ] Резервная копия реально создаётся (загляните в `backups/` на следующий день).
