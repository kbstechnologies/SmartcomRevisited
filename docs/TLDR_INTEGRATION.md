# tldr command intelligence

Smartcom watches what you type into a terminal, works out which command you are
running, and offers the tldr page for it — with each example turned into a small
command builder you can fill in, copy, insert or run against the session you
chose.

This is not a tldr client bolted on. There is no `tldr` binary to install, no
`npm i -g tldr`, and nothing to configure: the app owns the page set, the cache
and the index, and every one of them fails quietly if it has to.

```
                   User types command
                          │
                          ▼
                  Smartcom detects it
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
           TLDR                       AI
      examples, syntax        reasoning, risks
             │                         │
             ▼                         │
       Command Builder                 │
             │                         │
       ┌─────┼──────┬──────┐           │
       ▼     ▼      ▼      ▼           │
     Copy Insert  Run   Ask AI ────────┘
             │
             ▼
      The selected terminal
```

---

## Contents

- [Architecture](#architecture)
- [Data source and cache](#data-source-and-cache)
- [Updating, rebuilding and clearing](#updating-rebuilding-and-clearing)
- [Command detection](#command-detection)
- [Platform detection](#platform-detection)
- [The panel](#the-panel)
- [The command builder](#the-command-builder)
- [Copy, Insert and Run](#copy-insert-and-run)
- [Execution safety](#execution-safety)
- [Session safety](#session-safety)
- [The Command Center](#the-command-center)
- [Favourites](#favourites)
- [AI Agent integration](#ai-agent-integration)
- [Offline behaviour](#offline-behaviour)
- [Performance](#performance)
- [Logging](#logging)
- [Settings](#settings)
- [Building and installing](#building-and-installing)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Licensing and attribution](#licensing-and-attribution)
- [Known limitations](#known-limitations)

---

## Architecture

```
     tldr-pages GitHub release  (tldr-pages.en.zip + tldr.sha256sums)
                     │
                     ▼  fetch + SHA-256 verify         MAIN PROCESS
        ┌────────────────────────────┐
        │ electron/tldr/             │
        │   tldr-store.ts            │  download, unzip, index, write
        │   tldr-service.ts          │  lookup / search / getPage / update
        └────────────┬───────────────┘
                     │  <userData>/tldr/{meta,pages,index}.json
                     │
                 IPC │  tldr:status · tldr:lookup · tldr:search
                     │  tldr:page   · tldr:update · tldr:rebuild
                     │  tldr:clear  · tldr:run
                     ▼                                 RENDERER
        ┌────────────────────────────┐
        │ src/lib/commandLine.ts     │  reconstructs the typed line
        │ src/lib/useTldr.ts         │  debounce + lookup hooks
        │ src/components/            │
        │   TldrIndicator.tsx        │  the [ TLDR ] / [ AI ] chips
        │   TldrPanel.tsx            │  the right-hand panel
        │   TldrExampleCard.tsx      │  the command builder
        │   TldrCommandCenter.tsx    │  searchable, Ctrl+Shift+T
        │   TldrSettings.tsx         │  Settings › tldr
        └────────────────────────────┘

     Pure, shared, tested — used by both processes:
        src/shared/tldr.ts         page model, parser, placeholders, platforms
        src/shared/tldr-detect.ts  command detection, risk classification
        src/shared/tldr-search.ts  index shape and ranking
        src/shared/tldr-run.ts     the run gate
        src/shared/tldr-ai.ts      the question handed to the AI Agent
```

The split is deliberate: everything that can be a pure function is one, in
`src/shared/`, so the parts where being wrong matters — which command was
detected, whether it is destructive, which session it goes to — are testable
without an Electron process, an SSH connection or a browser.

**Markdown is parsed once, centrally.** The renderer never sees raw tldr
markdown; `tldr:page` returns a normalised `TldrPage`:

```ts
{
  command: 'tcpdump',
  platform: 'common',
  description: ['Dump traffic on a network.'],
  moreInfo: 'https://www.tcpdump.org/manpages/tcpdump.1.html',
  examples: [{
    description: 'Capture the traffic of a specific interface',
    template: 'sudo tcpdump {{[-i|--interface]}} {{eth0}}',
    placeholders: [
      { token: '[-i|--interface]', kind: 'option', choices: ['-i','--interface'], … },
      { token: 'eth0',             kind: 'value',  defaultValue: 'eth0', generic: false },
    ],
  }],
  otherPlatforms: ['linux'],
}
```

---

## Data source and cache

Pages come from the **tldr-pages project's own release assets** — not from
scraping `tldr.sh`:

| Asset | Used for |
|---|---|
| `tldr-pages.en.zip` (≈3.3 MB) | the English page set, ~7,400 pages |
| `tldr.sha256sums` | verifying the archive before it is unpacked |
| GitHub releases API | the version label only (`v2.3`), never required |

Downloaded from `https://github.com/tldr-pages/tldr/releases/latest/download/`,
so an installation picks up the current page set without an app update.

### Where it is stored

```
<userData>/tldr/
├── meta.json    what we have, where from, when
├── pages.json   { "<platform>/<command>": "<raw markdown>" }
└── index.json   the search index
```

`<userData>` is:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Smartcom Revisited\tldr` |
| macOS | `~/Library/Application Support/Smartcom Revisited/tldr` |
| Linux | `~/.config/Smartcom Revisited/tldr` |

The exact path is shown in **Settings › tldr**, with a button that opens it.

One file per artefact rather than 7,400 markdown files on disk: extraction
becomes a single write instead of thousands, which on Windows is the difference
between a second and a minute, and a half-finished extraction cannot leave the
cache in a state where some pages exist and others do not.

`meta.json` records:

```json
{
  "last_updated": "2026-09-01T09:12:44.101Z",
  "dataset_version": "v2.3",
  "languages": ["en"],
  "platforms": ["android","cisco-ios","common","dos","freebsd","linux","netbsd","openbsd","osx","sunos","windows"],
  "index_version": 2,
  "page_count": 7455,
  "source": "https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.en.zip",
  "checksum": "…sha256…"
}
```

`meta.json` is written **last**, deliberately. It is what the service treats as
proof the cache is complete, so a crash between writing the pages and writing
the index leaves a cache that reports itself as absent and is rebuilt — never
one that reports itself as ready and answers nothing.

---

## Updating, rebuilding and clearing

### Automatically

About twelve seconds after start-up — well behind the first paint and behind the
app's own update check — the service looks at the cache:

| State | What happens |
|---|---|
| Missing | Downloaded in the background |
| Older than the refresh interval (default 7 days) | **Stale cache stays in use** while a refresh runs behind it |
| Fresh | Nothing |

Start-up is never delayed by any of this, and a failure is swallowed: it is
recorded in the status the settings screen shows and nowhere else.

Turning off **Refresh the page set in the background** stops the refresh of a
working cache. It does not stop a *missing* cache being fetched — the setting is
about keeping the data current, not about having any.

### By hand

**Settings › tldr** has three buttons:

| Button | What it does | Network |
|---|---|---|
| **Update now** | Re-downloads, verifies, extracts and re-indexes | yes |
| **Rebuild index** | Re-indexes the pages already on disk | no |
| **Clear cache** | Deletes `<userData>/tldr/` entirely | no |

**Rebuild index** is the repair for a cache whose pages are fine but whose index
is stale or corrupt — which is what a bump of `TLDR_INDEX_VERSION` produces.
**Clear cache** is the repair for anything worse; the next start downloads it
again.

You can also delete `<userData>/tldr/` yourself while the app is closed. Nothing
else depends on it.

---

## Command detection

Smartcom has no command input box. A session is a raw pty and an xterm, and
every keystroke goes straight to the far end — so the only way to know what is
being typed is to watch the keystrokes go past. That is
`src/lib/commandLine.ts`: a **model** of the remote's line editor, fed from
`xterm.onData`.

It handles printable characters, backspace, `Ctrl+C`, `Ctrl+U`, `Ctrl+W` and
Enter. It cannot follow history recall, tab completion or cursor movement, so
rather than pretend it says so (`reliable: false`) and, for history recall,
discards the line rather than guessing.

The detected command is not the first word:

| Typed | Detected |
|---|---|
| `tcpdump -i eth0 port 5060` | `tcpdump` |
| `sudo tcpdump -i eth0` | `tcpdump` |
| `sudo -u root tcpdump -i eth0` | `tcpdump` |
| `sudo systemctl restart nginx` | `systemctl` |
| `docker ps -a` | `docker` |
| `ip route show` | `ip` |
| `grep foo /var/log/messages \| tail -20` | `grep` (also reports `tail`) |
| `env FOO=bar curl https://example.com` | `curl` |
| `timeout -k 5 30 ansible-playbook site.yml` | `ansible-playbook` |
| `/usr/bin/tcpdump -D` | `tcpdump` |
| `C:\Windows\System32\ipconfig.exe /all` | `ipconfig` |

Wrappers stepped over: `sudo`, `doas`, `pkexec`, `env`, `command`, `builtin`,
`exec`, `nohup`, `setsid`, `time`, `timeout`, `watch`, `nice`, `ionice`,
`stdbuf`, `xargs`, `strace`, `ltrace`, `proxychains`, `unbuffer`, `script`,
`sg`, `runuser`, `nix-shell` — including their own options and the values those
options take, which is why `sudo -u root tcpdump` finds `tcpdump` and not
`root`.

After Enter the last submitted line is kept, so help about the command you just
ran does not vanish the instant you commit to it.

### Passwords are never captured

A password typed at a prompt is keystrokes like any other. So the terminal's
*output* is watched for a prompt asking for a secret — `Password:`,
`[sudo] password for …:`, `Enter passphrase for key …:` — and while one is on
screen **nothing is recorded at all**, the buffer is emptied, and the chip goes
idle. It resumes once the prompt is no longer the last thing on screen.

That is a heuristic, not a guarantee, so nothing derived from the buffer leaves
the machine without redaction — see [AI Agent integration](#ai-agent-integration).

Detection can be turned off entirely in **Settings › tldr**. With it off, no
keystrokes are inspected at all; the panel and the Command Center still work
when opened deliberately.

---

## Platform detection

tldr pages are organised by platform, and showing a Linux page to someone at a
PowerShell prompt is worse than showing nothing — it looks authoritative.
Smartcom reads the platform off the connection the session was opened from:

| Connection | Platform | Search order |
|---|---|---|
| SSH (no tags) | `linux` | linux → common |
| SSH/serial tagged `cisco`, `ios` or `cisco-ios` | `cisco-ios` | cisco-ios → common |
| Local shell: `cmd`, `powershell` | `windows` | windows → dos → common |
| Local shell: `wsl` | `linux` | linux → common |
| Local shell: `bash`/`zsh`/`pwsh` on macOS | `osx` | osx → common → linux |
| Local shell: `bash`/`zsh`/`pwsh` elsewhere | `linux` | linux → common |
| Serial | `common` | common |
| Tagged `windows` / `linux` / `macos` | that platform | as above |

**Tags win over the transport.** Tagging a connection `cisco` is what turns
`show` into the IOS page rather than the Linux one — and `cisco-ios`
deliberately does *not* fall through to Linux, because `show`, `write` and
`reload` all exist there and mean something entirely different.

When a page exists on other platforms too, the panel offers them as buttons
rather than merging them.

---

## The panel

The tldr panel is a tab in the right-hand panel Smartcom already has, beside
**Buttons**, **Assistant** and the scratch pad. That is what gives it the drag
handle, the remembered width and the collapse control for free — and what
guarantees it never displaces a terminal or disturbs a session.

The tabs are icons rather than labels (bolt / sparkle / book / pencil, named on
hover): four text tabs plus seven utility buttons in one row left nothing
legible, and the panel is routinely dragged down to its 240px minimum.

```
┌──────────────────────────────────┬────────────────────────────┐
│  [Tabs][Grid][Full]  [TLDR ✓ tcpdump] [AI]   2 sessions       │
├──────────────────────────────────┼────────────────────────────┤
│                                  │ ⚡✨📖✎        🔍 🔑 📁 ⚙ ℹ │
│                                  ├────────────────────────────┤
│                                  │ tcpdump      Common  ☆  🔍 │
│  $ tcpdump -i eth0 port 5060     ├────────────────────────────┤
│                                  │ TARGET                     │
│                                  │ ● router-okc-01            │
│                                  │   admin@10.10.10.5:22      │
│                                  ├────────────────────────────┤
│                                  │ Dump traffic on a network. │
│                                  │ ↗ tcpdump.org/manpages/…   │
│                                  │                            │
│                                  │ Capture on an interface    │
│                                  │ tcpdump {{[-i|--interface] │
│                                  │ INTERFACE                  │
│                                  │ [ eth0                   ] │
│                                  │ GENERATED COMMAND          │
│                                  │ tcpdump -i eth0            │
│                                  │ [Copy][Insert][Run][AskAI] │
└──────────────────────────────────┴────────────────────────────┘
```

The chips sit in the workspace toolbar directly above the panes — the closest
thing this UI has to "beside what you are typing", because there is no input box
to attach them to.

| State | Chip | Meaning |
|---|---|---|
| Idle | `TLDR` (subdued) | nothing detected yet |
| Searching | `TLDR ✦` (pulsing) | a lookup is in flight |
| Found | `TLDR ✓ tcpdump` (blue) | there is a page; click to open it |
| Not found | `TLDR — foo` (subdued) | no page; click to search instead |

---

## The command builder

Every `{{…}}` in a tldr example becomes an input. Three token shapes are
recognised, by their own syntax rather than by guesswork:

| Token | Kind | Rendered as |
|---|---|---|
| `{{eth0}}` | value | a text field pre-filled with `eth0` |
| `{{[-i\|--interface]}}` | option | a picker, defaulting to the short form |
| `{{table\|list\|csv}}` | choice | a picker |

Fields are pre-filled from the token itself, because upstream tokens are usually
real examples — `{{eth0}}` is a working default. A token that only *describes* a
value (`{{path/to/file}}`, `{{filename}}`, `{{username}}`) is pre-filled too, but
it is flagged **needs a real value** and holds **Run** back until it has been
edited. Copy and Insert stay available: neither of them runs anything.

A token used twice is asked for once and filled in both places. The original
template stays on screen beside the generated command, so it is always clear
what was substituted where.

---

## Copy, Insert and Run

| Button | What happens | Needs a connected session |
|---|---|---|
| **Copy** | The generated command goes to the clipboard, through the main process (the sandboxed renderer's async clipboard API does not reliably get permission) | no |
| **Insert** | The command is placed on the target terminal's command line and **left there** | yes |
| **Run** / **Review & Run** | The command is sent to the target session, followed by Enter | yes |
| **Ask AI** | The generated command is handed to the AI Agent | no |

**Insert is the intended default.** It uses `sessions:insert-suggestion` — the
same channel as the assistant's Insert — which strips trailing line terminators
so the last line cannot submit itself, and refuses multi-line text when the
remote is not in bracketed-paste mode (a serial console or a device CLI would
otherwise act on every line). The workflow it is built for:

1. pick an example
2. fill in the variables
3. insert it
4. edit it in the terminal
5. press Enter yourself

---

## Execution safety

tldr is documentation, not a safety review — it documents `rm -rf` as
cheerfully as it documents `ls`. So the generated command is classified before
it can be sent, and anything that looks destructive becomes **Review & Run**:

```
You are about to run:

rm -rf /some/path

On:
server-prod-02 — admin@10.0.4.12:22

This removes files, and removes files recursively or without prompting.

[ Cancel ]  [ Run Command ]
```

The dialog is Smartcom's existing `ConfirmStep`, the same one an inline
`confirm` step in a button uses, with Cancel focused.

Classified as destructive: `rm`, `rmdir`, `shred`, `dd`, `mkfs*`, `fdisk`,
`parted`, `wipefs`, `shutdown`, `reboot`, `poweroff`, `halt`, `killall`,
`pkill`, `format`, `diskpart`; package removal (`apt`/`dnf`/`yum`/`apk`/
`pacman -R`/`zypper`/`brew`/`pip`/`npm`/`choco`); `systemctl disable|mask|stop`;
firewall flushes (`iptables -F/-X/-Z`, `nft flush`, `ufw reset`, `netsh
advfirewall reset`); `docker prune|rm|rmi|kill`, `docker compose down`,
`kubectl delete|drain`; `DROP DATABASE`, `DELETE FROM`, `TRUNCATE TABLE`,
`dropDatabase()`, `FLUSHALL`; `git reset --hard`, `git clean -f`,
`git push --force`; writes to `/dev/sd*`; recursive `chmod`/`chown`; `crontab
-r`; PowerShell `Remove-Item -Recurse`, `Stop-Computer`, `Clear-Disk`; and
Cisco `write erase`, `reload`, `erase`, `no ip …`, `delete`.

Every segment of a pipeline is classified, not just the first — so
`find /tmp -name '*.log' | xargs rm -f` is caught.

**This is a speed bump, not a security boundary.** It is not an attempt at a
perfect parser, and it cannot be: the operator can type anything they like into
the terminal regardless. The point is that a command half-read in a
documentation panel gets a second look before it is sent. The classification
deliberately errs towards asking — being asked about a harmless `docker rm`
costs one click.

The gate is enforced in the **main process** (`src/shared/tldr-run.ts`, called
from the `tldr:run` handler), not only in the UI. A panel that forgot to ask
cannot make a destructive command run.

---

## Session safety

Everything that acts does so on **one named session**, shown at the top of the
panel and captured when the panel was opened — not the session in focus at the
moment a button is pressed. The whole point of a panel you read for a while is
that you might click a tab in the meantime, and "whichever terminal is in front
now" is how a command meant for a lab box reaches production.

| Situation | Behaviour |
|---|---|
| Target session closed | Insert and Run disabled; panel says **Target session disconnected**; Copy and Ask AI still work |
| Target not connected | Insert and Run disabled, naming the box |
| You switch to another terminal | The panel says the page still targets the original, and offers a button to retarget. It never silently follows focus |
| `tldr:run` names a session that no longer exists | Refused in main. Never redirected to another session |
| Destructive command without confirmation | Refused in main, with the reasons, so the panel can ask |

There is no broadcast path from the tldr panel, and no "active session"
fallback in the run handler.

---

## The Command Center

`Ctrl+Shift+T` (or `Cmd+Shift+T`), the 📖 button in the panel header, or the
TLDR chip when nothing is detected.

Searches command names, descriptions **and example text**, which is what makes
intent queries work — someone who already knows the command name usually does
not need to look it up:

```
Search: capture traffic

tcpdump      Dump traffic on a network.            Common
tshark       Terminal version of Wireshark.        Common
dumpcap      Dump network traffic.                 Common
```

`tcpdump` · `tcp` · `dkr` (fuzzy → `docker`) · `restart service` · `find large
files` · `docker containers` all work.

Every term must match something, so "tcpdump kubernetes" returns nothing rather
than everything — **unless** the strict pass finds almost nothing, in which case
it relaxes to "at least one term", with each page still scored against the full
term count. That is what answers "find large files": `find` is plainly the
answer and its page never says "large".

Ranking is lexical, over what upstream actually wrote. There is no popularity
signal in the corpus, so the tie-breaks are how thoroughly a page is documented
and whether its platform applies to this session at all. Pages for a platform
the session could never use are pushed right down; `common` is never demoted
relative to `linux` for a Linux session, since both apply equally.

Results are one row per command — the highest-ranked platform variant — and the
session's own platform breaks ties. Selecting one opens it in the same panel.

The shortcut is also handled inside xterm (`attachCustomKeyEventHandler`),
because a focused terminal swallows keys before they reach the document — and a
focused terminal is exactly when you want it. It does not collide with anything:
`Ctrl+K` is the command palette and the terminal's own bindings are
`Ctrl+Shift+C` / `Ctrl+Shift+V`.

---

## Favourites

The ☆ in the panel header stars a command. Starred commands are stored in
settings (`tldrFavourites`) and are what the Command Center lists before you
have typed anything.

---

## AI Agent integration

**There is no second AI system.** Ask AI writes a question and hands it to the
existing assistant, which sends it through the same `ai:ask` as anything typed
by hand — same provider, same model, same streaming, same
[propose-never-execute contract](../src/shared/assistant-contract.ts). No new
`ai:*` IPC channel was added; that surface is frozen by
`electron/ai/assistant-cannot-execute.test.ts`, and deliberately so.

Ask AI is available from four places, and always carries the *generated* command
rather than the unresolved template:

1. the **AI** chip beside TLDR, for whatever is currently typed
2. a tldr page as a whole
3. an individual example
4. an example after its placeholders have been filled in

The question it builds:

```
Explain this command in more detail:

```
tcpdump -i eth0 port 5060
```

Platform: linux
Target session: router-okc-01 (ssh)
tldr page: tcpdump
tldr example: Capture the traffic of a specific interface

Please cover:
- what each option means
- what the command will actually do here
- any risks, especially anything irreversible
- common variations worth knowing
- what output I should expect
```

**What is not sent** matters as much as what is: no terminal history, no
scrollback, no credentials. The command itself is redacted first — with the
assistant's own `redactSecrets`, plus a set of command-line-shaped patterns
(`--password=…`, `mysql -pHunter2`, `snmpwalk -c …`, `sshpass -p …`,
`curl -u user:pass`) that output-shaped redaction does not catch.

Ask AI works when tldr has no page at all, which is the point of having both: a
serial console into a PBX has almost no tldr coverage and the assistant has no
such gap.

Answers come back into the assistant panel, where every code block has **Copy**
and **Insert** — never Run. AI-generated commands default to Insert by design.

---

## Offline behaviour

| State | tldr | Terminal |
|---|---|---|
| Cache present, no network | Works normally, from disk | Unaffected |
| No cache, no network | "tldr documentation unavailable." | Unaffected |
| Download failed | Reason shown in Settings › tldr | Unaffected |
| Cache corrupt | Treated as absent; **Rebuild index**, or re-download | Unaffected |

A lookup never touches the network. It reads an index already in memory in the
main process, so an unreachable github.com costs nothing at all once the cache
exists.

**No tldr failure can prevent Smartcom starting, and none can stop a terminal
working.** The service is constructed after the window is up, `ensureCache()` is
never awaited, and its errors are swallowed into the reported status.

---

## Performance

- Keystrokes are folded into the line model synchronously — a handful of string
  operations, on the same path that sends them to the far end, and always
  *before* the send so nothing is delayed by it.
- Lookups are **debounced by 300 ms**, so a line typed at speed is one IPC round
  trip, not thirty.
- A lookup is an index scan in memory. No disk, no network, no markdown parsing.
- `pages.json` (~4 MB) is read lazily, on the first page actually opened. A
  session where nobody opens the panel never pays for it.
- Parsed pages are memoised, so reopening one costs nothing.
- Search is a scored scan over ~7,400 entries — a few milliseconds. No
  Elasticsearch, no index server, no extra dependency.
- Out-of-order answers are discarded by generation counter, so a slow lookup for
  an older command can never overwrite a newer one.

---

## Logging

Through the app's existing console logging, prefixed `[tldr]`:

```
tldr.cache-missing · tldr.cache-stale · tldr.cache-fresh
tldr.update-start · tldr.update-done · tldr.update-error · tldr.update-failed
tldr.rebuild-start · tldr.rebuild-done · tldr.cache-cleared
tldr.page-missing · tldr.parse-error · tldr.pages-unreadable
[tldr] command executed { sessionId, destructive }
```

A command run from the panel is also written to the **audit log**, under the
button name `tldr` (or `tldr (confirmed)` when it was destructive), with the
session and connection, exactly as a macro run is. Nothing that could be a
credential is logged.

---

## Settings

**Settings › tldr**:

| Setting | Key | Default |
|---|---|---|
| Detect commands as they are typed | `tldrEnabled` | on |
| Refresh the page set in the background | `tldrAutoUpdate` | on |
| Refresh after (days) | `tldrUpdateIntervalDays` | 7 |
| Favourites | `tldrFavourites` | `[]` |

Plus the cache status — last updated, dataset version, page count, platforms,
languages, index version, size on disk, cache location — and **Update now**,
**Rebuild index**, **Clear cache**.

---

## Building and installing

Nothing extra to install or configure. The normal build works:

```bash
npm install          # fflate is a runtime dependency, in package.json
npm run verify       # typecheck + lint + tests + db smoke + build
npm run dev          # vite + electron
npm run package:win  # or package:mac / package:linux
```

### The one dependency this added

| Package | Version | Why |
|---|---|---|
| [`fflate`](https://github.com/101arrowz/fflate) | ^0.8.3 | The tldr release asset is a ZIP, and nothing already in the runtime dependencies can read one. `fflate` is pure JavaScript with no dependencies of its own, so it bundles into `dist-electron/main.js` — no native module, no ABI rebuild, nothing new for `electron-rebuild` to handle |

`package.json` and `package-lock.json` are updated. No new runtime is
introduced: this is the same Electron main process, the same React renderer, the
same Zustand store and the same IPC bridge as everything else.

---

## Testing

```bash
npm test
```

| File | Covers |
|---|---|
| `src/shared/tldr.test.ts` | markdown parsing, descriptions, upstream links, placeholder shapes, substitution, multiple placeholders, platform mapping |
| `src/shared/tldr-detect.test.ts` | tokenising, pipelines, wrappers (`sudo`, `sudo -u root`, `env`, `watch -n`, `timeout`), absolute and Windows paths, and the destructive classifier |
| `src/shared/tldr-search.test.ts` | exact, partial, description, example-text and fuzzy search; platform preference and fall-back |
| `src/shared/tldr-run.test.ts` | session safety: missing session, disconnected session, confirmation gate, order of checks |
| `src/shared/tldr-ai.test.ts` | the AI question and payload, and that credentials are redacted out of both |
| `src/lib/commandLine.test.ts` | the typed-line model, including that a password at a prompt is never captured |
| `electron/tldr/tldr-service.test.ts` | the whole cache path against a real ZIP: download, checksum verification, extraction, indexing, lookup, search, corrupt cache, download failure, offline rebuild, concurrent updates, staleness |

The existing `electron/ai/assistant-cannot-execute.test.ts` still passes
unchanged — no `ai:*` channel was added and no assistant file gained a way to
execute anything.

---

## Troubleshooting

**The TLDR chip never leaves "idle".**
Check **Settings › tldr** — if the status is *Not downloaded*, press **Update
now**. If detection is off, the chip stays inert by design.

**The chip is idle only while typing a password.**
Working as intended. Capture is suspended while the far end is asking for a
secret.

**The wrong command is detected after pressing ↑ or Tab.**
The line model cannot follow history recall or completion. Press `Ctrl+C` or
Enter and the next line is tracked normally.

**Linux pages on a Windows or Cisco session.**
Set the connection's tags (`windows`, `cisco`) or, for a local session, the
shell kind. See [Platform detection](#platform-detection).

**"tldr documentation unavailable."**
This machine could not reach `github.com`. The terminal is unaffected. Retry
with **Update now** when it can, or copy `<userData>/tldr/` from a machine that
already has it — the three files are portable.

**Search finds nothing but pages clearly exist.**
The index is stale or corrupt. **Rebuild index** (no network needed). If that
fails, **Clear cache** and **Update now**.

**Run is greyed out.**
Either a placeholder still holds its example text (it will say *needs a real
value*), or the target session is not connected. Hover the button for the
reason.

**Update fails with a checksum error.**
The archive did not match the checksum the release published — a proxy rewriting
the download, or a corrupt transfer. The old cache is kept untouched. Retry.

---

## Licensing and attribution

The tldr pages are content from the
[tldr-pages](https://github.com/tldr-pages/tldr) project, licensed
**CC BY 4.0** (Creative Commons Attribution 4.0 International). The project's
own `LICENSE.md` travels inside the archive Smartcom downloads and is not
stripped.

Attribution appears in three places, all of which must be kept:

1. **About Smartcom Revisited** — "Command documentation from the tldr-pages
   project, used under CC BY 4.0", linking to the repository.
2. **The tldr panel** — a footer on every page shown.
3. **This document.**

Page content is not modified — only parsed and re-rendered. Smartcom's own code
remains MIT; the licences are separate and neither is applied to the other.

---

## Known limitations

- **English only.** `tldr-pages.en.zip` is what is downloaded. The cache format
  already records `languages`, and other archives exist per language, so adding
  a language picker is a small change — but it is not there yet.
- **The typed-line model is a model.** History recall, tab completion and cursor
  movement are detected and reported as unreliable, not followed. There is no
  way to do better without cooperation from the far end.
- **Password detection is a heuristic.** It covers the common prompts. Redaction
  is the backstop, not the first line.
- **Subcommand pages are searchable but not contextual.** tldr documents
  `git commit` as a page named `git-commit`; typing `git commit` detects `git`,
  as specified. Searching "git commit" in the Command Center finds the specific
  page.
- **`cisco-ios` has 17 pages upstream.** Vendor CLIs are thinly covered in
  general, which is why the not-found state offers **Ask AI** rather than an
  apology.
- **Related commands are approximate.** They are the top search hits for the
  command's own name, which works well (`tcpdump` surfaces `tshark`) but is not
  a curated relationship.
- **No page-level history integration.** Per-line TLDR/AI buttons in terminal
  output were considered and left out: xterm renders output as a canvas, and
  overlaying controls on individual lines would mean re-implementing selection
  and scrolling. The last submitted command is kept in the chip instead, which
  covers the same need without touching the terminal renderer.
