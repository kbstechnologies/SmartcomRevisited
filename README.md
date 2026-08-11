# Smartcom Revisited

A cross-platform Electron SSH terminal — PuTTY on steroids. Multiple sessions in a
tmux-style grid, programmable macro buttons whose scripts are assembled from
Scratch-like blocks, popup forms that feed variables into those scripts,
one-click session logging, and managed SSH keys.

## Features

### Sessions and layout
- Multiple concurrent SSH **and serial** sessions — a serial port behaves like any
  other session, so buttons, forms, logging and `wait for prompt` all work on it
- Connections can be organised into **groups**, and exported/imported as JSON
  (secrets are deliberately left out of the export)
- Hosts can be edited and **deleted** — one at a time or every ticked host at
  once. Deleting removes the saved password or key passphrase with it. Open
  sessions keep running, and the audit log keeps its entries, still labelled
  with the host they were run on
- Three layouts, toggled from the toolbar: **Tabs**, **Grid** (tmux-like), **Full screen**
- In grid mode the highlighted pane is the target for macro buttons
- **Open many hosts at once** — tick the checkboxes in the host picker; the layout
  switches to grid automatically
- **Broadcast** mode sends everything to every connected session at once — both
  what you type *and* the buttons you press. A form is answered once and the
  same values go to every host; the panel tells you how many it is aiming at
- Panes stay mounted, so scrollback survives switching layouts
- The side panel **drags wider or narrower** and remembers the width; double-click
  the divider to reset it
- **PuTTY mouse habits**: drag to select, **right-click to copy** the selection,
  and right-click with nothing selected to **paste**. `Ctrl`+`Shift`+`C` and
  `Ctrl`+`Shift`+`V` do the same from the keyboard — plain `Ctrl`+`C` stays as
  interrupt, where it belongs
- **Pop a terminal out** into its own window for a second monitor. The button
  panel stays in the main window and still targets whichever pane has focus, in
  any window; each window keeps its own view and its own scrollback

### Programmable buttons
Buttons live in sets, carry an icon and colour, and run a script when clicked.

Scripts are built as a stack of coloured blocks (the Flow tab of the button editor):

| Block | What it does |
| --- | --- |
| **Send text** | Types text into the session. Supports `{{VAR}}`, optional Enter, repeat, delay |
| **Wait for prompt** | Blocks until output matches a regex, or times out |
| **Wait seconds** | Fixed pause |
| **Ask for input** | Pops a form *mid-script*; answers become variables for every later step |
| **Pause** | Waits for the operator to click Resume |
| **If prompt … else** | Branches on whether a pattern appears; a timeout takes the else branch |
| **Run button** | Runs another button's script, passing variables down |
| **Run button set** | Runs every button in another set, in order |
| **Exit** | Stops the script; "exit all" also stops the caller |

Any block can be marked *keep going if this step fails*.

**Button sets install like plugins.** Export a set to a `.json` file and anyone
can import it: every set and button comes in under a fresh id, name clashes
become `"Ops (imported)"`, and nothing you already have is modified or replaced.

### Forms and variables
- A button can collect inputs **before** it runs (Inputs tab) or **at any point in
  the flow** via an *Ask for input* block
- Field types: text, number, password, select, checkbox, textarea — each with a
  label, default, hint and required flag
- Values substitute into `{{NAME}}` anywhere in the script
- Calling another button passes variables down: the callee inherits the caller's
  variables, its own defaults fill the gaps, and explicit arguments win
- Recursive calls are detected and refused rather than hanging

### Session logging (PuTTY style)
- One button in the status bar starts/stops logging for the focused session
- Per-pane logging toggles in grid mode
- `plain` strips ANSI escapes for readable logs; `raw` keeps them
- Optional auto-start on connect; click the filename to reveal it on disk

### SSH keys
- **Generate RSA keypairs** (2048/3072/4096), optionally passphrase-protected
- **Install a key on a host** — the `ssh-copy-id` equivalent: appends to
  `~/.ssh/authorized_keys` with correct permissions, skipping if already present.
  Reuses an open session so no password is needed
- Import existing keys (PEM or OpenSSH), copy the public key, export to disk
- Private keys are encrypted by the OS keystore and never stored in the database

> Generation is RSA only. Node can only emit ed25519 private keys as PKCS#8,
> which OpenSSH refuses to read, so generating one would produce an unusable
> file. Create ed25519 keys with `ssh-keygen -t ed25519` and import them.

### AI assistant
A side panel that can read what is happening in the focused session and answer
questions about it — "what is this box complaining about?", "what command do I
need here?". Backed by Claude, OpenAI or a local Ollama model, switchable at
runtime. It is read-only by design: it proposes commands and you decide whether
to send them. Bring your own API key; keys live in the same OS keystore as SSH
secrets, and secrets in the session text are redacted before anything is sent.

### Other
- Per-profile **startup script** that runs once the shell is ready
- Audit log of every command and macro run, exportable to CSV/JSON
- Command palette (`Ctrl`/`Cmd`+`K`)

## Getting started

```bash
npm install          # also rebuilds native modules for Electron
npm run dev          # vite + electron with hot reload
```

If the app exits immediately after install, the native SQLite module is built for
the wrong ABI — run `npm run rebuild:native`.

### Verifying

```bash
npm run verify       # typecheck + lint + tests + build
```

## Building installers

```bash
npm run package:win     # NSIS installer + portable .exe (x64)
npm run package:mac     # .dmg + .zip (x64 and arm64)
npm run package:linux   # AppImage + .deb (Debian/Ubuntu) + .rpm (RedHat/Fedora)
```

Each platform must be built on its own OS — a `.dmg` needs macOS and `.deb`/`.rpm`
need Linux. `.github/workflows/build.yml` builds all three on GitHub-hosted
runners and attaches them to a draft release when you push a `v*` tag.

From Windows you can still produce the Linux artifacts with Docker, on a copy of
the tree that has no `node_modules` (the container installs its own):

```bash
docker run --rm -v "$PWD:/project" -w /project electronuserland/builder:latest \
  bash -c "npm install && npx electron-builder --linux AppImage deb rpm -p never"
```

The app must not be running while packaging: Windows holds a lock on the native
modules and the build fails partway through.

Builds are unsigned by default; supply signing certificates as CI secrets to
enable code signing and notarisation.

### Icons

`brand/` holds the source artwork. `npm run brand` regenerates `build/icon.png`,
the multi-size `build/icon.ico` and the in-app logos under `src/assets/`;
electron-builder derives the macOS `.icns` and the Linux PNG set from
`build/icon.png`.

## Coming from PuTTY

`tools/import-putty-sessions.bat` (double-click) or the `.ps1` beside it converts
saved PuTTY sessions into a connections file you can import. It is a standalone
script — it does not need the app installed, reads the registry without writing
to it, and only produces a file.

```powershell
.\tools\import-putty-sessions.ps1                          # this user's sessions
.\tools\import-putty-sessions.ps1 -DefaultUser admin       # username to assume
.\tools\import-putty-sessions.ps1 -RegFile colleague.reg   # someone else's export
```

Then use **New → Import** in the app. Importing adds the connections alongside
what you already have; nothing is replaced.

SSH and serial sessions come across, with serial framing (baud, bits, parity,
flow control) translated. Two things it tells you about rather than guessing:

- PuTTY often has **no username saved**, because it asks at connect time. Those
  get `-DefaultUser` (your Windows username unless you say otherwise) and are
  listed at the end so you can correct them.
- A session using a **`.ppk` key** keeps the path, but PuTTY's key format is its
  own. Convert each with PuTTYgen (*Conversions → Export OpenSSH key*) and point
  the connection at the result.

Telnet, raw and rlogin sessions are skipped and named in the summary. No
passwords are carried across, because PuTTY does not store any.

## Updating

Installing a newer version keeps everything: connections, button sets, keys,
settings and the audit log live in the user data directory, not in the install
directory, and the Windows installer explicitly skips its data cleanup when it
is upgrading rather than uninstalling.

The database migrates itself forward — columns are added when missing, so a
database written by an older version opens fine. Before the first run of a new
version touches it, a consistent snapshot is written to `backups/` beside the
database (the five most recent are kept). About shows which version you upgraded
from and links to that folder.

The app checks for a new release shortly after start-up and shows the result in
About — never a modal over a live terminal, and never an unannounced restart.
What it can do next depends on how it was installed:

| Installed as | Updating |
| --- | --- |
| Windows installer (`.exe`) | Downloads and installs on restart |
| Linux `AppImage` | Downloads and installs on restart |
| Linux `.deb` / `.rpm` | Your package manager owns it — the app only tells you |
| macOS | Unsigned builds cannot self-update; the app links to the download |
| Windows portable `.exe` | Replace the file yourself |

Turn the check off with `autoUpdateCheck`, or keep the check and skip the
background download with `autoUpdateDownload`.

## Security

- Passwords, key passphrases and private keys are encrypted with Electron
  `safeStorage`, which uses DPAPI on Windows, the Keychain on macOS and
  libsecret/kwallet on Linux. The vault file holds ciphertext only, written
  `0600` via write-then-rename
- On Linux that means GNOME Keyring or KWallet, chosen by desktop environment.
  It needs `libsecret` — the `.deb` and `.rpm` depend on it, but an AppImage
  relies on the system having it (`apt install libsecret-1-0`,
  `dnf install libsecret`). **About** names the backend actually in use, so a
  fallback is visible rather than silent
- If no OS keystore is available (common on headless Linux without a keyring),
  saving a secret fails loudly rather than silently writing plaintext
- Deleting a profile or key removes its secrets from the vault
- Renderer runs sandboxed with context isolation; every IPC message is validated
  against a zod schema in the main process

## Project layout

```
electron/           main process
  main.ts           IPC surface, window, wiring
  ssh-manager.ts    sessions, session logging, macro engine
  key-manager.ts    RSA generation, OpenSSH encoding, key deployment
  keychain.ts       safeStorage-backed secret vault
  database.ts       SQLite schema, migrations, CRUD
  window-manager.ts main window plus popped-out terminal windows
  updater.ts        release checks, and what each install kind may do about them
  ai/               assistant providers and prompt assembly
src/
  components/       React UI (ScriptBuilder is the block editor)
  lib/              session output buffer, pane selection, icon map
  shared/           zod types + IPC contract shared by both processes
  store/            zustand store
```

## Testing

`test-server/` brings up three throwaway SSH containers to develop against
(`npm run testserver:up`). They exist only on your machine and their login —
`testuser` / `testpass` — is a fixture, not a credential worth protecting. See
[TESTING.md](TESTING.md).

## License

MIT — see LICENSE.
