# Phone companion setup

The phone companion is a static Progressive Web App. It has no app server and no AI API connection. It stores an encrypted copy in the browser and uses Google Picker plus the Google Drive API to read or update one encrypted vault file that you choose.

## Before connecting the phone

1. Install and sign in to **Google Drive for desktop** on the PC.
2. In Second Brain, open **Sync & security** → **Choose Drive folder** and select a folder inside your Google Drive mirror.
3. Press **Sync now** and set a passphrase of at least 12 characters. Do not forget it; the app never stores it and cannot recover it.
4. Wait until Google Drive for desktop has uploaded `SecondBrainVault.sbvault`.

## Host the phone page

The `phone` folder must be served from an HTTPS address for Google sign-in, encryption, and installable offline use. Use any static HTTPS host you control. The page code is public to anyone who can open its URL; your brain and passphrase are not in the page. The page sends only encrypted vault bytes to Drive.

## Google setup

In Google Cloud Console, create a project and:

1. Enable **Google Drive API** and **Google Picker API**.
2. Configure the Google Auth Platform consent screen for your Google account. For personal use, keep the app in testing and add your own Google account as a test user.
3. Create an **OAuth client ID** for a **Web application**. Add the exact phone page origin (scheme + host, without a path) under authorized JavaScript origins.
4. Create an API key. Restrict it to the Google Picker API and Google Drive API. For website restrictions, add your phone page origin and `https://docs.google.com/*` because Picker opens inside a Google-hosted frame.
5. Copy the web client ID, API key, and numeric Cloud project number into **Google Drive setup** on the phone page. These browser identifiers are public; restrict the API key to your site and the listed APIs.

The companion requests the `drive.file` permission and Google Picker grants access only to the file you select. It does not ask to read every file in Drive.

## Connect and use

1. Open the phone page and choose **Choose vault in Drive**.
2. Select `SecondBrainVault.sbvault`.
3. Use **Unlock your brain** with the same passphrase as the PC.
4. Capture notes or add reminders while online or offline. They are encrypted in the phone browser.
5. Press **Sync now** to exchange changes. On the PC, press **Sync now** again after Google Drive for desktop has downloaded the updated encrypted file.
6. Use your browser's **Add to Home Screen** option for app-like access and offline opening.

The phone keeps a local encrypted cache in IndexedDB. The encryption key, Google access token, and passphrase are not saved there. Choose **Lock this brain** when finished. If two devices edit the same note, both versions are kept under `conflicts/`; reminders are merged by ID and conflicting reminder edits are duplicated for review.

## Limits and recovery

- Keep the local `Documents\SecondBrain` folder backed up. It remains the readable source on the PC.
- Do not delete `SecondBrainVault.sbvault` or remove the app's access to it from Drive if you still need the synced copy.
- If you forget the passphrase, an encrypted sync copy cannot be recovered. The readable PC vault remains available if it has not been deleted.
- Sync one device at a time when possible. Google Drive for desktop can make its own duplicate file if the same file is changed concurrently while a device is offline.
- This first phone build captures notes and manages reminders. It does not send phone push notifications.
