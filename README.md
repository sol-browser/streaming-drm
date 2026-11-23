# Sol Streaming DRM

The optional Streaming DRM component of [Sol](https://github.com/sol-browser/sol).
Netflix, Spotify and other services play only in a browser that passes Widevine's
protected playback check. Sol is built on CEF, which cannot pass it, so it shows
these services through this component: [castLabs ECS](https://github.com/castlabs/electron-releases)
(Electron for Content Security), packaged for Sol and VMP-signed by castLabs EVS.

This is not a standalone browser. Sol downloads it only when a person turns
Streaming DRM on in Settings, starts it only for a supported service, and shows
it inside that service's tab. Every other site opens in Sol as usual.

## How Sol uses it

- **Download.** Each Sol build pins one release: its file, size and SHA-256.
  Sol downloads it without cookies or credentials, accepts only the pinned
  hash and unpacks it next to its own folder. A newer Sol that pins a newer
  release replaces it on its own.
- **Isolation.** Sol starts the component with a private named pipe that only
  the current Windows user and that process can open, and checks the
  process ID on connection. Sol sends the services it allows (hosts, sign-in
  pages, controls) with each tab, and the component's tabs navigate only
  within them. Links that leave a service open in Sol as ordinary tabs.
- **Data.** Sign-ins and site data stay in a separate folder per Sol profile,
  with cookies encrypted for the Windows account. Saved passwords, passkeys,
  autofill and extensions are not available there. Widevine licences come
  from each service through Google's Widevine module.

## Releases

A release id is `<ECS version>-<revision>`, for example `45.2.1-7`. Each
release carries `Sol-Streaming-DRM-<id>-win-x64.zip`, its `.sha256` and
`release.json` (id, size, installed size, SHA-256, ECS and Chromium versions,
source commit, VMP signature).

Releases are never replaced or deleted: older Sol builds still download the
release they pin.

## Building a release

Releases are built by the [Release workflow](.github/workflows/release.yml)
from this repository:

1. Update `ecs.lock.json` when castLabs publishes a new ECS release: version,
   download URL and SHA-256 of `electron-v<version>+wvcus-win32-x64.zip`.
   Take ECS patch releases for their Chromium security fixes.
2. Run the workflow with the next revision number and approve the run.
3. Pin the new release in Sol and ship it with a Sol release.

`scripts/build.ps1 -Revision <n>` builds the same package locally without
signing it, for inspection.

## License

The component's own code is under the [Mozilla Public License 2.0](LICENSE),
like Sol. The package contains Electron and Chromium under their licenses
(`LICENSE` and `LICENSES.chromium.html` in the archive).
