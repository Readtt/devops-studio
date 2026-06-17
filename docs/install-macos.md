# Installing DevOps Studio on macOS

DevOps Studio is **not yet code-signed or notarized for macOS** — the project
doesn't have an Apple Developer Program account. The builds work, but on first
launch macOS Gatekeeper will refuse them with a message like:

> "DevOps Studio" can't be opened because Apple cannot check it for malicious
> software.

That's expected for any unsigned `.app` downloaded from the internet. You only
need to clear it **once per install** — after that the app launches normally.

## Download

Grab the right asset for your Mac from the
[latest release](https://github.com/Readtt/devops-studio/releases/latest):

| Mac | Asset |
|-----|-------|
| Apple Silicon (M1 / M2 / M3 / M4) | `DevOps Studio_x.y.z_aarch64.dmg` |
| Intel | `DevOps Studio_x.y.z_x64.dmg` |

Open the `.dmg` and drag **DevOps Studio.app** into `/Applications`.

## Clear Gatekeeper (pick one)

### Method 1 — strip the quarantine attribute (most reliable)

When macOS downloads a file it tags it with the `com.apple.quarantine` extended
attribute. Removing the tag tells Gatekeeper to treat the app as approved:

```bash
xattr -dr com.apple.quarantine "/Applications/DevOps Studio.app"
```

Then double-click the app as normal. (Adjust the path if you installed it
somewhere other than `/Applications`.)

### Method 2 — System Settings → Open Anyway (macOS 13+)

1. Double-click **DevOps Studio.app** and dismiss the "can't be opened" alert.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Click **Open Anyway** next to the *"DevOps Studio was blocked…"* line.
4. Confirm with Touch ID or your password.

### Method 3 — right-click → Open (older macOS)

Right-click (Control-click) **DevOps Studio.app** in `/Applications`, choose
**Open**, then click **Open** in the dialog. On macOS 15 (Sequoia) this option
has been removed — use Method 1 or 2 there.

## Auto-updates still work

Once the app is running, the in-app updater handles future versions normally — it
verifies each update against the embedded minisign public key, independent of
Apple notarization. You only do the Gatekeeper dance on the **initial install**
(and again if you delete and re-download the `.dmg`).

## Verifying a download (optional)

Every release artifact ships with a matching `.sig` (minisign signature). To
confirm a download came from the project's release workflow and wasn't tampered
with in transit:

```bash
brew install minisign
minisign -V \
  -P "RWRTOev0yXiod8C0vSWzcy3GyQDzPgEr2K/YyiTwFb/WOtE4Fjew8RgH" \
  -m "DevOps Studio_x.y.z_aarch64.dmg" \
  -x "DevOps Studio_x.y.z_aarch64.dmg.sig"
```

That public key is the same one baked into the app for auto-update verification
(`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`), so it's safe to share.

## Why isn't this signed?

macOS code signing requires an Apple Developer Program membership ($99/year).
Once the project has one, the release workflow already has the env-var plumbing
in place (see `.github/workflows/release.yml` history) — it's a matter of adding
a Developer ID certificate, an Apple API key for notarization, and the matching
repo secrets. Until then, the Gatekeeper bypass above is the workaround.
