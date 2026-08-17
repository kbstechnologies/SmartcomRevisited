# AppImage updates and KEM-A AppManager

Status as of 1.3.0: **the metadata is produced and verified locally; the public
update feed has not been exercised end to end.** Nothing in the app or on the
website claims AppManager compatibility yet, and it must not until the checks at
the bottom of this file have actually been run against a published release. See
"What has and has not been proven".

## Two update mechanisms, easily confused

| | Used by | Produced by |
|---|---|---|
| `latest-linux.yml` | electron-updater, inside the running app | electron-builder, already |
| `.upd_info` ELF section + `.zsync` file | AppImageUpdate, AppMan, **KEM-A AppManager** | `tools/appimage-update-info.js`, added in 1.3.0 |

These are independent. Before 1.3.0 the AppImage could update itself perfectly
through the app's own updater while being completely invisible to any external
manager: a freshly built 1.3.0 AppImage was inspected and its `.upd_info`
section was present but **entirely zeroed**, and no `.zsync` file was written.

That is what `tools/appimage-update-info.js` fixes. It writes the update
information string in place (the section is pre-allocated by the AppImage
runtime, so the payload and its signature are untouched) and runs `zsyncmake`.

## Required release filenames

The update information embedded in the AppImage is:

```
gh-releases-zsync|kbstechnologies|SmartcomRevisited|latest|SmartcomRevisited-*-x86_64.AppImage.zsync
```

Read literally: *on the **latest** release of `kbstechnologies/SmartcomRevisited`,
find the single asset matching `SmartcomRevisited-*-x86_64.AppImage.zsync`.*

So every release **must** attach both of these, named exactly like this:

| Asset | Example at 1.3.0 |
|---|---|
| `SmartcomRevisited-<version>-x86_64.AppImage` | `SmartcomRevisited-1.3.0-x86_64.AppImage` |
| `SmartcomRevisited-<version>-x86_64.AppImage.zsync` | `SmartcomRevisited-1.3.0-x86_64.AppImage.zsync` |

Three ways this breaks, all silent:

- **Renaming the AppImage after running the script.** The `.zsync` records the
  filename it was built from; a rename leaves the updater unable to fetch it.
- **Publishing the `.zsync` without the AppImage** (or vice versa).
- **More than one asset matching the glob** — an arm64 AppImage named
  `SmartcomRevisited-1.4.0-x86_64.AppImage.zsync` by mistake, say. The pattern
  must match exactly one file per release.

The update URL clients resolve is therefore:

```
https://github.com/kbstechnologies/SmartcomRevisited/releases/latest/download/SmartcomRevisited-<version>-x86_64.AppImage.zsync
```

`releases/latest` is what makes a client holding 1.3.0 able to name a file from
a release that did not exist when it was installed.

## Producing the files

Linux artefacts are built in the pinned container (never in the dev tree — the
container's `npm install` would replace the Windows-native modules):

```bash
docker run --rm -v "<staged copy>:/project" -w /project electronuserland/builder:20 bash -c "
  apt-get update -qq && apt-get install -y -qq zsync &&
  npm install && npm run build &&
  npx electron-builder --linux AppImage deb rpm -p never &&
  node tools/appimage-update-info.js release/SmartcomRevisited-*-x86_64.AppImage
"
```

`zsync` is not in the image and has to be installed; `readelf` and `objcopy`
already are. Verify afterwards:

```bash
readelf -p .upd_info release/SmartcomRevisited-*-x86_64.AppImage
ls -l release/*.zsync
```

The first must print the `gh-releases-zsync|…` line, not an empty section.

## Settings are preserved across an update

An AppImage update replaces the single executable file. Smartcom keeps its
database, vault references and logs under `~/.config/smartcom-revisited`
(Electron's `userData`), which the AppImage never touches — so an in-place
update by AppManager or any other tool keeps every connection, button set and
setting. This is a property of where the data lives, not something the updater
does, which is why it holds for whatever tool performs the update.

## What has and has not been proven

Verified locally, on the real 1.3.0 AppImage:

- The `.upd_info` section reads back exactly the intended string.
- `zsyncmake` produces a well-formed `.zsync` (193 KB for a 111 MB AppImage).
- The AppImage still runs after patching — the section is pre-allocated padding.

**Not yet verified, and required before any compatibility claim is published:**

1. A release carrying both assets under the exact names above.
2. KEM-A AppManager installing that AppImage and creating its desktop entry.
3. A *second* release published, and AppManager detecting it as newer.
4. AppManager updating in place, with connections and settings intact
   afterwards.

Until all four have been done against a real published release:

- **Do not** add "Compatible with KEM-A AppManager" to the Linux download
  instructions.
- **Do not** advertise automatic updates for the AppImage anywhere public.

The metadata being correct is necessary but not sufficient; the claim is about
another program's behaviour, and only running it proves anything.
