# Downloads and releases

Download Harbor DB from [GitHub Releases](https://github.com/aligeek-tech/harbor-db/releases). Choose a release asset below; GitHub's automatically generated **Source code** archives do not contain an installed application.

Version **0.1.9** delivers the integrated database-workbench checkpoint, searchable product-icon connection picker, exact-value vector transport safeguards, cancellation-safe local task startup, stronger DuckDB file grants and expanded Linux packages. The 78-ticket roadmap remains incomplete; preview and externally unverified capabilities are identified in [CAPABILITIES.md](CAPABILITIES.md) and the roadmap ledger.

MongoDB connections now support authorized database/collection browsing, Extended JSON find filters and read-only aggregation pipelines, and confirmed document insert/edit/delete. BSON types survive editing; replacements keep the original `_id`, and replacement/deletion reject concurrent document changes. Saved queries keep their database, collection and query mode. Read-only safeguards remain enforced in the main process. See [MongoDB capabilities and limits](CAPABILITIES.md#mongodb) for query syntax, connection options and bounded previews.

The large TimescaleDB table preview fix from 0.1.4 is included.

| Computer                           | Release asset                               | Installation                                                                                      |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ubuntu/Debian, Intel or AMD 64-bit | `Harbor-DB-VERSION-linux-amd64.deb`         | Install the Debian package; launch **Harbor DB** from the application menu.                       |
| Linux, Intel or AMD 64-bit         | `Harbor-DB-VERSION-linux-x86_64.AppImage`   | Make the file executable and launch it as your normal user.                                       |
| Mac with an Intel processor        | `Harbor-DB-VERSION-mac-x64.dmg` or `.zip`   | Open the DMG and drag **Harbor DB** into Applications, or extract the ZIP and move the app there. |
| Mac with Apple Silicon             | `Harbor-DB-VERSION-mac-arm64.dmg` or `.zip` | Use the ARM build for M-series Macs; install as above.                                            |
| Windows, Intel or AMD 64-bit       | `Harbor-DB-VERSION-win-x64.exe`             | Run the installer and choose an installation directory.                                           |

For this release, replace `VERSION` with `0.1.9`. Linux x64 and ARM64 installers are produced. Windows ARM installers are not produced. macOS 13 or later is required by [Electron 44](https://www.electronjs.org/blog/electron-44-0). Builds run on native Linux, Intel Mac, Apple Silicon Mac, and Windows runners; a successful packaging job does not establish compatibility with every operating-system version.

## Linux distribution coverage

Native x64 and ARM64 builds provide four formats each:

| Distribution family | Format | Architecture suffixes | Boundary |
| --- | --- | --- | --- |
| Debian, Ubuntu, Linux Mint, Pop!_OS | DEB | `amd64.deb`, `arm64.deb` | Ubuntu24.04 native runner verification; other versions require compatible libraries. |
| Fedora, RHEL-compatible, openSUSE | RPM | `x86_64.rpm`, `aarch64.rpm` | Package format supplied; individual distribution installations are not all certified. |
| Arch, Manjaro, other glibc desktops | AppImage or tar.gz | `x86_64.AppImage`, `arm64.AppImage`, `x64.tar.gz`, `arm64.tar.gz` | Requires compatible system libraries and a working Chromium sandbox. |
| Alpine/musl, 32-bit, ARMv7, RISC-V | None | — | Not supported by these Electron/native DuckDB artifacts. |

All filenames begin `Harbor-DB-0.1.9-linux-`. Portable archives avoid the FUSE requirement: extract the complete directory and launch `harbor-db` as your normal user. Archives do not install libraries, launcher integration or sandbox policy. RPM installation uses the distribution package manager (`dnf install ./FILE.rpm` or `zypper install ./FILE.rpm`); DEB installation uses `apt install ./FILE.deb`. Use a maintained glibc desktop with GTK3, NSS, GBM, ALSA and the required X11/Wayland libraries. Ubuntu24.04 is the native CI baseline, not a universal minimum-version guarantee. Locked-down namespace policies may require administrator-approved per-app sandbox configuration; never use `--no-sandbox` or disable system-wide protections.

Flatpak/Flathub, Snap Store and AUR repositories are not published by this workflow. Availability of a portable download is not certification of every Linux OS or packaging ecosystem.

## Verify a download

Download `SHA256SUMS` from the same release and compare the entry for your installer. On Linux, use `sha256sum FILE`; on macOS, use `shasum -a 256 FILE`; in Windows PowerShell, use `Get-FileHash FILE -Algorithm SHA256`. When all thirteen assets are in one directory, Linux can check them together with `sha256sum --check SHA256SUMS`.

Checksums detect a damaged or mismatched download. They are published beside the assets and do not replace publisher signing or independently establish who built the application.

## Publisher verification and first launch

The current releases do not use purchased signing certificates or Apple notarization. Windows installers are unsigned. Mac applications have an ad-hoc signature for executable integrity, with hardened-runtime entitlements, but no verified Developer ID or Apple notarization.

macOS may block the first launch. Review the release and checksum before deciding whether to use the per-app **Open Anyway** option in **System Settings → Privacy & Security**. See [Apple's explanation of opening an app from an unknown developer](https://support.apple.com/guide/mac-help/mh40616/mac). The option may be unavailable under an organization's management policy. Do not disable Gatekeeper globally.

Windows may show an unknown-publisher or SmartScreen warning. If the release is one you trust, Windows may offer **More info → Run anyway**; managed systems can prevent this. These builds do not claim Microsoft-verified publisher status. Do not turn off SmartScreen globally to install the app.

On Ubuntu/Debian, install the DEB using the package manager, for example:

```sh
sudo apt install ./Harbor-DB-0.1.9-linux-amd64.deb
```

The application itself runs as your regular user. The Debian package integrates the application icon and launcher; its installer also supplies an application-specific AppArmor policy on supported systems so Chromium can create its sandbox namespaces. Do not launch Harbor DB with `sudo` or `--no-sandbox`.

For an AppImage:

```sh
chmod +x Harbor-DB-0.1.9-linux-x86_64.AppImage
./Harbor-DB-0.1.9-linux-x86_64.AppImage
```

AppImages need compatible FUSE support and permission to create Chromium sandbox namespaces. On Ubuntu systems that restrict those namespaces, prefer the DEB, which installs the policy for its fixed executable path. The development setup command below grants access to development/unpacked executables only; it does not grant arbitrary AppImages permission. Do not disable the Chromium sandbox or change a system-wide namespace restriction to work around installation.

## Publishing a version

The repository's [Release Harbor DB workflow](../.github/workflows/release.yml) starts when a `v*` tag is pushed. The tag must exactly match `v` followed by `package.json`'s version. Keep `package-lock.json` synchronized with that version. The current release tag is `v0.1.9`.

Before tagging, verify a clean `npm ci`, then run the build and required checks. Installing into an existing `node_modules` tree alone does not verify optional cross-platform dependency entries in the lockfile.

After reviewing and committing the release changes on the intended commit:

```sh
git tag -a v0.1.9 -m "Harbor DB 0.1.9"
git push origin v0.1.9
```

The workflow uses Node.js 24, `npm ci`, and the pinned Electron/builder versions. It runs the verification workflow and builds the thirteen installers in parallel on `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15` (ARM64), and `windows-2025`. The architectures match [GitHub's hosted-runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Build jobs have read-only repository permission and call electron-builder with `--publish never`; signing credentials are not needed for the current configuration.

Publication waits for lint, TypeScript, unit tests, real PostgreSQL/MariaDB/MongoDB/Redis integration, sandboxed Electron UI tests, unpacked-package checks, and all native build jobs. The publishing job checks that all thirteen expected installers exist, creates `SHA256SUMS`, adds installation notes and GitHub-generated changes, uploads the complete set to a draft, and then publishes it. A tag containing a prerelease suffix is marked as a prerelease. Only that final job receives `contents: write`; it uses the workflow's short-lived `GITHUB_TOKEN` rather than a stored personal token. Actions are pinned to reviewed commit IDs.

If a job fails, fix the cause and rerun it from Actions. A failed upload leaves a draft that a rerun can complete. Already-public releases are not overwritten by this workflow: publish corrected binaries under a new version and tag. Do not move a published tag. Artifacts from build jobs expire after seven days; published release assets remain downloadable independently of Actions artifact retention. Repository administrators may need to allow GitHub Actions and its requested release permission before the first run.

## Building locally

`npm run package` creates an unpacked application for the current host in `release/`. `npm run dist` creates its configured installers. To select one target explicitly after building:

```sh
npm ci
npm run build
npx electron-builder --linux --x64 --publish never
# On an Intel Mac: npx electron-builder --mac --x64 --publish never
# On an Apple Silicon Mac: npx electron-builder --mac --arm64 --publish never
# On Windows: npx electron-builder --win --x64 --publish never
```

Build on the matching operating system and architecture. Do not override `mac.identity` with `null`: the configured `"-"` identity supplies the ad-hoc signature without certificate secrets. `mac.notarize` is deliberately disabled for these releases. To introduce verified signing later, configure the appropriate certificate/provider, enable and supply Apple notarization credentials for macOS, then test the signatures on downloaded artifacts before changing the release claims.

On Linux, launch an unpacked build with `./release/linux-unpacked/harbor-db` and keep the entire directory together. With the disposable development databases running, test it with `HARBOR_PACKAGE=1 npx playwright test tests/package.e2e.ts`. Test launching from an ordinary terminal as well: an IDE or automation process may pass down namespace permission that a normal terminal lacks. See [VALIDATION.md](VALIDATION.md).

On Ubuntu systems that block development sandbox namespaces, run `npm run setup:linux` once from the workspace in an ordinary terminal. Setup prints and validates an AppArmor profile for the exact development Electron and `release/linux-unpacked/harbor-db` paths, then uses `sudo` only to install and load that profile. It preserves sandboxing and does not change a system-wide kernel setting. If the workspace moves, rerun setup for its new paths. Inspect the generated policy with `node scripts/linux-sandbox.mjs print`.

The app uses Electron's bundled `node:sqlite`; there is no SQLite native addon to rebuild. Optional SSH acceleration is not required. Icon sources and generated PNG/ICO/ICNS assets live in `resources/`.

## Release validation

Before announcing a release, check the workflow result and the actual downloadable assets, including their checksums. Exercise first-run save/connect, invalid credentials, unreachable hosts, locked OS keyrings, restored disconnected tabs, SSH/TLS, editor workers, and the normal application launcher. Verify remembered credentials with an actual OS keychain, outside Playwright's test keychain/password-store setup. Test light/dark themes at desktop and compact sizes and review [CAPABILITIES.md](CAPABILITIES.md) for supported operations.

Linux local testing, successful remote builds, and actual macOS/Windows user testing are separate evidence. Record what ran in [VALIDATION.md](VALIDATION.md); do not claim a platform was exercised solely because its installer was generated. Updates are manual downloads and must not interrupt active queries or transactions.
