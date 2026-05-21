# Installing DevOps Studio on macOS

DevOps Studio is **not yet code-signed or notarized for macOS** — the project
doesn't have an Apple Developer Program account. The builds work, but macOS
Gatekeeper will refuse to launch them on first run with a message like:

> "DevOps Studio" can't be opened because Apple cannot check it for malicious
> software.

This is the expected behavior for any unsigned `.app` downloaded from the
internet. Here's how to get past it.

## Download

Grab the right asset for your Mac from the
[latest release](https://github.com/Readtt/devops-studio/releases/latest):

| Mac | Asset |
|-----|-------|
| Apple Silicon (M1 / M2 / M3 / M4) | `DevOps Studio_x.y.z_aarch64.dmg` |
| Intel | `DevOps Studio_x.y.z_x64.dmg` |

Open the `.dmg` and drag **DevOps Studio.app** into `/Applications`.

## Method 1 — right-click → Open (recommended, GUI only)

1. Open **Finder** and go to `/Applications`.
2. **Right-click** (or Control-click) on **DevOps Studio.app**.
3. Choose **Open** from the context menu.
4. macOS will show a dialog with an **Open** button. Click it.

You only have to do this **once per install**. After that, the app launches
normally from Spotlight / Launchpad / Dock.

If the right-click dialog only shows **Move to Trash** and no **Open** button,
use Method 2 below.

## Method 2 — strip the quarantine attribute (Terminal)

When macOS downloads a file from the internet, it tags it with the
`com.apple.quarantine` extended attribute. Removing the tag tells Gatekeeper
to treat the app as if it was already approved.

```bash
xattr -dr com.apple.quarantine "/Applications/DevOps Studio.app"
```

Then double-click the app like normal.

If you installed somewhere other than `/Applications`, adjust the path.

## Method 3 — System Settings (macOS 15+ Sequoia)

On recent macOS versions, the right-click trick has been removed in favor of
a settings-pane override:

1. Double-click **DevOps Studio.app** and dismiss the "can't be opened" alert.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section.
4. You'll see a line: *"DevOps Studio was blocked from use because it is not
   from an identified developer"*. Click **Open Anyway**.
5. Confirm with Touch ID / password.

## Auto-updates still work

Once the app is running, the in-app updater handles future versions normally
— it verifies each update's signature against the embedded minisign public
key, which is independent of Apple's notarization. You only have to do the
Gatekeeper dance on the **initial install**.

If you ever reinstall fresh (delete + re-download the .dmg), you'll need to
do it again.

## Why isn't this signed?

Code signing for macOS requires an Apple Developer Program membership
($99/year). Once we have one, the release workflow already has the env-var
plumbing in place (see `.github/workflows/release.yml` history) — adding it
back is a matter of generating a Developer ID Application certificate, an
Apple API key for notarization, and pasting the resulting secrets into the
repo's Actions settings.

Until then, the Gatekeeper bypass is the workaround.

## Verifying you downloaded a real release

Every release artifact in the GitHub release has a matching `.sig` file
(minisign signature). If you're paranoid about a tampered download, you can
verify it with the `minisign` tool:

```bash
brew install minisign
minisign -V \
  -P "RWRTOev0yXiod8C0vSWzcy3GyQDzPgEr2K/YyiTwFb/WOtE4Fjew8RgH" \
  -m "DevOps Studio_x.y.z_aarch64.dmg" \
  -x "DevOps Studio_x.y.z_aarch64.dmg.sig"
```

The pubkey above is the same one baked into the app for auto-update
verification — it's safe to share. A successful verification proves the file
was built by the project's release workflow and hasn't been modified in
transit.
