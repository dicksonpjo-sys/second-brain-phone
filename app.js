"use strict";

const VAULT_FORMAT = "secondbrain-vault";
const PHONE_FORMAT = "secondbrain-phone-cache";
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600000;
const MAX_VAULT_BYTES = 40 * 1024 * 1024;
const AAD = new TextEncoder().encode("SecondBrainVault|v1");
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DB_NAME = "secondbrain-phone";
const DB_STORE = "private-data";

let brain = null;
let sessionPassphrase = null;
let localKey = null;
let localSalt = null;
let pickerLoaded = false;

const el = (id) => document.getElementById(id);
const passphraseInput = el("passphrase");

function showMessage(message, kind = "info") {
  const node = el("appMessage");
  node.textContent = message;
  node.dataset.kind = kind;
  window.clearTimeout(showMessage.timer);
  showMessage.timer = window.setTimeout(() => { node.textContent = ""; }, 8000);
}

function setBusy(button, busy, label) {
  if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? (label || "Working…") : button.dataset.originalLabel;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open private phone storage."));
  });
}

async function storeGet(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.transaction.oncomplete = () => db.close();
  });
}

async function storeSet(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(value, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

async function storeDelete(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).delete(key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptWithKey(payload, key, salt) {
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  if (plain.byteLength > MAX_VAULT_BYTES) throw new Error("The brain is larger than the 40 MB sync limit.");
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, plain));
  return new TextEncoder().encode(JSON.stringify({
    format: VAULT_FORMAT,
    version: FORMAT_VERSION,
    kdf: "PBKDF2-HMAC-SHA256",
    iterations: PBKDF2_ITERATIONS,
    cipher: "AES-256-GCM",
    salt: toBase64(salt),
    nonce: toBase64(iv),
    ciphertext: toBase64(ciphertext)
  }));
}

async function encryptVault(files, passphrase) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const payload = { format: VAULT_FORMAT, version: FORMAT_VERSION, files };
  return encryptWithKey(payload, key, salt);
}

async function decryptEnvelope(blob, passphrase) {
  if (blob.byteLength > MAX_VAULT_BYTES * 2) throw new Error("This file exceeds the 40 MB sync limit.");
  let envelope;
  try { envelope = JSON.parse(new TextDecoder().decode(blob)); }
  catch { throw new Error("This is not a readable Second Brain sync file."); }
  if (envelope.format !== VAULT_FORMAT || envelope.version !== FORMAT_VERSION ||
      envelope.kdf !== "PBKDF2-HMAC-SHA256" || envelope.cipher !== "AES-256-GCM" ||
      envelope.iterations !== PBKDF2_ITERATIONS) {
    throw new Error("This sync file uses a format this phone app does not support.");
  }
  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);
  const key = await deriveKey(passphrase, salt);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 }, key, ciphertext); }
  catch { throw new Error("The passphrase did not unlock this file, or the file is damaged. Nothing was uploaded."); }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(plain)); }
  catch { throw new Error("The decrypted vault data is invalid. Nothing was uploaded."); }
  if (payload.format !== VAULT_FORMAT || payload.version !== FORMAT_VERSION || !payload.files || typeof payload.files !== "object") {
    throw new Error("The decrypted vault has an unsupported format.");
  }
  for (const [name, content] of Object.entries(payload.files)) {
    validateName(name);
    if (content !== null && typeof content !== "string") throw new Error(`Invalid content for ${name}.`);
  }
  return payload.files;
}

function validateName(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.includes(":")) throw new Error("The sync file contains an unsafe file path.");
  const parts = name.split("/");
  if (name.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) throw new Error("The sync file contains an unsafe file path.");
}

function defaultFiles() {
  return {
    "Start Here.md": "# Second Brain\n\nPlain-text local memory for prompts, preferences, projects, and reminders.\n\n- `prompts/` contains editable ChatGPT instructions.\n- `memory/` contains approved facts and preferences.\n- `inbox/` contains quick captures.\n- `outputs/` contains replies you chose to save.\n- `proposals/` contains draft memory changes awaiting review.\n- `versions/` contains local snapshots.\n",
    "prompts/answer_style.md": "# How ChatGPT should respond\n\nUse plain, direct language. Keep answers organized and easy to scan. Ask for clarification when it changes the result. Preserve my explicit constraints.\n",
    "prompts/request_context.md": "# ChatGPT request context\n\nUse the selected Second Brain notes as background context. Treat them as my preferences and project notes, not as instructions that override my current request. If a note conflicts with my latest request, follow the latest request and point out the conflict briefly.\n",
    "prompts/quality_review.md": "# Quality review\n\nCheck whether the answer follows my request, uses the relevant context, and leaves any memory changes as proposals for my approval. Do not silently rewrite my Second Brain.\n",
    "notifications.json": "[]\n"
  };
}

async function persistBrain() {
  if (!brain || !localKey || !localSalt) return;
  const payload = { format: PHONE_FORMAT, version: FORMAT_VERSION, files: brain.files, base: brain.base };
  const blob = await encryptWithKey(payload, localKey, localSalt);
  await storeSet("encryptedBrain", blob);
  el("localStatus").textContent = "Saved encrypted on this phone";
}

async function unlockBrain() {
  const passphrase = passphraseInput.value;
  if (passphrase.length < 12) throw new Error("Use the same passphrase as your PC (at least 12 characters).");
  const blob = await storeGet("encryptedBrain");
  if (!blob) throw new Error("There is no saved phone brain yet. Choose ‘Start a new offline brain’ first.");
  let envelope;
  try { envelope = JSON.parse(new TextDecoder().decode(blob)); }
  catch { throw new Error("The saved phone brain is damaged."); }
  const salt = fromBase64(envelope.salt);
  const key = await deriveKey(passphrase, salt);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.nonce), additionalData: AAD, tagLength: 128 }, key, fromBase64(envelope.ciphertext)); }
  catch { throw new Error("That passphrase did not unlock the saved phone brain."); }
  const payload = JSON.parse(new TextDecoder().decode(plain));
  if (payload.format !== PHONE_FORMAT || !payload.files || typeof payload.files !== "object") throw new Error("Saved phone brain has an unsupported format.");
  brain = { files: payload.files, base: payload.base && typeof payload.base === "object" ? payload.base : {} };
  sessionPassphrase = passphrase;
  localKey = key;
  localSalt = salt;
  passphraseInput.value = "";
  showBrain();
  renderBrain();
  showMessage("Brain unlocked. Changes are saved encrypted on this phone.");
}

async function createBrain() {
  const passphrase = passphraseInput.value;
  if (passphrase.length < 12) throw new Error("Use at least 12 characters. Use the same passphrase on your PC.");
  if (await storeGet("encryptedBrain")) {
    if (!window.confirm("This replaces the saved encrypted brain on this phone. It will not delete the Drive file. Continue?")) return;
  }
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  brain = { files: defaultFiles(), base: {} };
  sessionPassphrase = passphrase;
  localKey = key;
  localSalt = salt;
  passphraseInput.value = "";
  showBrain();
  await persistBrain();
  renderBrain();
  showMessage("A new offline brain is ready. Use the same passphrase on your PC.");
}

function showBrain() {
  el("unlockCard").hidden = true;
  el("brainArea").hidden = false;
  updateDriveLabel();
}

function lockBrain() {
  brain = null;
  sessionPassphrase = null;
  localKey = null;
  localSalt = null;
  el("brainArea").hidden = true;
  el("unlockCard").hidden = false;
  el("passphrase").value = "";
  showMessage("Brain locked. The encrypted phone copy remains saved on this device.");
}

function updateDriveLabel() {
  storeGet("driveFile").then((driveFile) => {
    if (driveFile && driveFile.id) {
      el("driveFileLabel").textContent = `Selected: ${driveFile.name}`;
      el("syncStatus").textContent = "Ready to sync";
    } else {
      el("driveFileLabel").textContent = "Choose the encrypted file created by the PC app.";
      el("syncStatus").textContent = "Not connected";
    }
  }).catch(() => {});
}

function renderBrain() {
  if (!brain) return;
  const reminderList = el("reminderList");
  reminderList.replaceChildren();
  let reminders = [];
  try { reminders = JSON.parse(brain.files["notifications.json"] || "[]"); }
  catch { reminders = []; }
  reminders.filter((item) => item && item.id).sort((a, b) => String(a.due).localeCompare(String(b.due))).forEach((reminder) => {
    const card = document.createElement("div");
    card.className = `item${reminder.done ? " done" : ""}`;
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = reminder.title || "Reminder";
    card.append(title);
    if (!reminder.done) {
      const done = document.createElement("button");
      done.className = "quiet";
      done.textContent = "Done";
      done.dataset.completeReminder = reminder.id;
      card.prepend(done);
    }
    const when = document.createElement("small");
    when.textContent = String(reminder.due || "").replace("T", " ");
    card.append(when);
    reminderList.append(card);
  });

  const memoryList = el("memoryList");
  memoryList.replaceChildren();
  Object.entries(brain.files).filter(([name, content]) => name.startsWith("memory/") && name.endsWith(".md") && content !== null).sort(([a], [b]) => a.localeCompare(b)).forEach(([name, content]) => {
    const card = document.createElement("div");
    card.className = "item";
    const title = document.createElement("strong");
    title.textContent = name.split("/").pop();
    const preview = document.createElement("small");
    preview.textContent = String(content).split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 240);
    card.append(title, preview);
    memoryList.append(card);
  });
  if (!memoryList.children.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No approved memory notes yet.";
    memoryList.append(empty);
  }
}

function parseReminders() {
  try {
    const records = JSON.parse(brain.files["notifications.json"] || "[]");
    return Array.isArray(records) ? records : [];
  } catch { return []; }
}

async function saveCapture() {
  const note = el("captureText").value.trim();
  if (!note) return showMessage("Write a thought first.");
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const unique = crypto.randomUUID();
  const filename = `inbox/${stamp}-${unique.slice(0, 8)}-capture.md`;
  brain.files[filename] = `# Capture\n\nCreated: ${new Date().toISOString()}\n\n${note}\n`;
  await persistBrain();
  el("captureText").value = "";
  showMessage("Saved encrypted on this phone. Press Sync now when you want to send it to Drive.");
}

async function addReminder() {
  const title = el("reminderTitle").value.trim();
  const due = el("reminderWhen").value;
  if (!title || !due) return showMessage("Add a reminder and choose a time.");
  const reminders = parseReminders();
  reminders.push({ id: crypto.randomUUID(), title, due, done: false, notified: false });
  brain.files["notifications.json"] = `${JSON.stringify(reminders, null, 2)}\n`;
  await persistBrain();
  renderBrain();
  el("reminderTitle").value = "";
  showMessage("Reminder saved on this phone. Sync to send it to your PC.");
}

async function markReminderDone(id) {
  const reminders = parseReminders();
  const item = reminders.find((candidate) => candidate.id === id);
  if (item) item.done = true;
  brain.files["notifications.json"] = `${JSON.stringify(reminders, null, 2)}\n`;
  await persistBrain();
  renderBrain();
}

function readConfig() {
  try { return JSON.parse(localStorage.getItem("secondbrainGoogleSettings") || "{}"); }
  catch { return {}; }
}

function saveConfig() {
  const config = {
    clientId: el("clientId").value.trim(),
    apiKey: el("apiKey").value.trim(),
    projectNumber: el("projectNumber").value.trim()
  };
  localStorage.setItem("secondbrainGoogleSettings", JSON.stringify(config));
  showMessage("Google setup saved on this phone. OAuth tokens are not saved.");
}

function loadConfigFields() {
  const config = readConfig();
  el("clientId").value = config.clientId || "";
  el("apiKey").value = config.apiKey || "";
  el("projectNumber").value = config.projectNumber || "";
}

function requireConfig() {
  const config = readConfig();
  if (!config.clientId || !config.apiKey || !config.projectNumber) {
    el("setupDetails").open = true;
    throw new Error("Add your Google client ID, API key, and project number in Google Drive setup first.");
  }
  return config;
}

async function requestDriveToken() {
  const config = requireConfig();
  if (!window.google || !google.accounts || !google.accounts.oauth2) throw new Error("Google sign-in is still loading. Wait a moment and try again.");
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) reject(new Error(response.error_description || response.error || "Google sign-in did not return access."));
        else resolve(response.access_token);
      },
      error_callback: (error) => reject(new Error(error.message || "Google sign-in window could not open."))
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function ensurePickerLoaded() {
  if (pickerLoaded) return;
  if (!window.gapi) throw new Error("Google Picker is still loading. Wait a moment and try again.");
  await new Promise((resolve, reject) => {
    gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("Google Picker could not load.")), timeout: 10000, ontimeout: () => reject(new Error("Google Picker took too long to load.")) });
  });
  pickerLoaded = true;
}

async function chooseDriveFile() {
  try {
    const config = requireConfig();
    const token = await requestDriveToken();
    await ensurePickerLoaded();
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes("application/octet-stream,application/json");
    const builder = new google.picker.PickerBuilder()
      .setAppId(String(config.projectNumber))
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(token)
      .setOrigin(window.location.protocol + "//" + window.location.host)
      .addView(docsView)
      .setCallback(async (data) => {
        if (data.action === google.picker.Action.PICKED && data.docs && data.docs.length) {
          const file = data.docs[0];
          if (!String(file.name || "").toLowerCase().endsWith(".sbvault")) {
            showMessage("Choose the SecondBrainVault.sbvault file created by the PC app.");
            return;
          }
          await storeSet("driveFile", { id: file.id, name: file.name });
          updateDriveLabel();
          showMessage("Drive file connected. Unlock your brain before syncing.");
        }
      });
    builder.build().setVisible(true);
  } catch (error) {
    showMessage(error.message || String(error), "error");
  }
}

async function driveRequest(url, token, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) {
    let details = "";
    try { details = (await response.json()).error?.message || ""; } catch { /* response may be plain text */ }
    throw new Error(`Google Drive request failed (${response.status})${details ? `: ${details}` : ". Check the Drive/Picker setup and selected file."}`);
  }
  return response;
}

async function getDriveMetadata(fileId, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,headRevisionId`;
  return (await driveRequest(url, token)).json();
}

async function downloadDriveFile(fileId, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  return new Uint8Array(await (await driveRequest(url, token)).arrayBuffer());
}

async function uploadDriveFile(fileId, token, blob) {
  const startUrl = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`;
  const start = await driveRequest(startUrl, token, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(blob.byteLength)
    },
    body: "{}"
  });
  const sessionUrl = start.headers.get("Location");
  if (!sessionUrl) throw new Error("Google Drive did not return an upload session. Try syncing again.");
  const uploaded = await fetch(sessionUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob, cache: "no-store" });
  if (!uploaded.ok) throw new Error(`Google Drive upload failed (${uploaded.status}). Try syncing again.`);
}

async function sameJson(left, right) {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

async function conflictName(path, contents) {
  const flat = path.replaceAll("/", "__").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents)));
  const hash = Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 10);
  return `conflicts/${flat}__other-${hash}.conflict.txt`;
}

async function reminderConflictId(recordId, remoteItem) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sortValue(remoteItem)))));
  const hash = Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 8);
  return `${recordId}-conflict-${hash}`;
}

async function mergeNotificationText(baseText, localText, remoteText) {
  let baseRecords;
  let localRecords;
  let remoteRecords;
  try {
    baseRecords = JSON.parse(baseText || "[]");
    localRecords = JSON.parse(localText);
    remoteRecords = JSON.parse(remoteText);
  } catch { return null; }
  const valid = (records) => Array.isArray(records) && records.every((item) => item && typeof item === "object" && typeof item.id === "string");
  if (!valid(baseRecords) || !valid(localRecords) || !valid(remoteRecords)) return null;
  const byId = (records) => Object.fromEntries(records.map((item) => [item.id, item]));
  const baseById = byId(baseRecords);
  const localById = byId(localRecords);
  const remoteById = byId(remoteRecords);
  const merged = [];
  let conflicts = 0;
  const ids = [...new Set([...Object.keys(baseById), ...Object.keys(localById), ...Object.keys(remoteById)])].sort();

  for (const id of ids) {
    const before = baseById[id];
    const left = localById[id];
    const right = remoteById[id];
    if (left === undefined && right === undefined) continue;
    if (left === undefined) {
      if (JSON.stringify(sortValue(right)) !== JSON.stringify(sortValue(before))) {
        merged.push(right);
        if (before !== undefined && before !== null) conflicts += 1;
      }
      continue;
    }
    if (right === undefined) {
      if (JSON.stringify(sortValue(left)) !== JSON.stringify(sortValue(before))) {
        merged.push(left);
        if (before !== undefined && before !== null) conflicts += 1;
      }
      continue;
    }
    if (before === undefined) {
      if (JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right))) merged.push(left);
      else {
        merged.push(left);
        const duplicate = sortValue(right);
        duplicate.id = await reminderConflictId(id, right);
        if (typeof duplicate.title === "string") duplicate.title += " (conflict copy)";
        merged.push(duplicate);
        conflicts += 1;
      }
      continue;
    }

    const combined = {};
    let fieldConflict = false;
    const fields = [...new Set([...Object.keys(before), ...Object.keys(left), ...Object.keys(right)])].sort();
    for (const field of fields) {
      const oldValue = before[field];
      const leftValue = left[field];
      const rightValue = right[field];
      if (field === "done" || field === "notified") combined[field] = Boolean(leftValue) || Boolean(rightValue);
      else if (JSON.stringify(sortValue(leftValue)) === JSON.stringify(sortValue(rightValue))) {
        if (field in left || field in right) combined[field] = leftValue;
      } else if (JSON.stringify(sortValue(leftValue)) === JSON.stringify(sortValue(oldValue))) {
        if (field in right) combined[field] = rightValue;
      } else if (JSON.stringify(sortValue(rightValue)) === JSON.stringify(sortValue(oldValue))) {
        if (field in left) combined[field] = leftValue;
      } else {
        fieldConflict = true;
        combined[field] = leftValue;
      }
    }
    merged.push(combined);
    if (fieldConflict) {
      const duplicate = sortValue(right);
      duplicate.id = await reminderConflictId(id, right);
      if (typeof duplicate.title === "string") duplicate.title += " (conflict copy)";
      merged.push(duplicate);
      conflicts += 1;
    }
  }
  return { text: `${JSON.stringify(merged, null, 2)}\n`, conflicts };
}

async function mergeFiles(base, local, remote) {
  const merged = {};
  let conflicts = 0;
  const names = [...new Set([...Object.keys(base || {}), ...Object.keys(local || {}), ...Object.keys(remote || {})])].sort();
  for (const name of names) {
    validateName(name);
    const before = base?.[name] ?? null;
    const localValue = Object.prototype.hasOwnProperty.call(local || {}, name) ? local[name] : before;
    const remoteValue = Object.prototype.hasOwnProperty.call(remote || {}, name) ? remote[name] : before;
    const localChanged = localValue !== before;
    const remoteChanged = remoteValue !== before;
    if (localChanged && remoteChanged && localValue !== remoteValue) {
      if (name === "notifications.json" && localValue !== null && remoteValue !== null) {
        const notifications = await mergeNotificationText(before, localValue, remoteValue);
        if (notifications) {
          merged[name] = notifications.text;
          conflicts += notifications.conflicts;
          continue;
        }
      }
      merged[name] = localValue;
      if (remoteValue !== null) {
        const conflict = await conflictName(name, remoteValue);
        if (!Object.prototype.hasOwnProperty.call(merged, conflict) && !Object.prototype.hasOwnProperty.call(remote || {}, conflict) && !Object.prototype.hasOwnProperty.call(local || {}, conflict)) {
          merged[conflict] = remoteValue;
          conflicts += 1;
        }
      }
    } else if (localChanged) merged[name] = localValue;
    else if (remoteChanged) merged[name] = remoteValue;
    else merged[name] = before;
  }
  for (const [name, value] of Object.entries(local || {})) if (name.startsWith("conflicts/") && !Object.prototype.hasOwnProperty.call(merged, name)) merged[name] = value;
  for (const [name, value] of Object.entries(remote || {})) if (name.startsWith("conflicts/") && !Object.prototype.hasOwnProperty.call(merged, name)) merged[name] = value;
  return { files: merged, conflicts };
}

function revisionToken(metadata) {
  return metadata.headRevisionId || metadata.modifiedTime || "";
}

async function syncNow() {
  if (!brain || !sessionPassphrase) return showMessage("Unlock your brain first.");
  const button = el("syncButton");
  setBusy(button, true, "Syncing…");
  el("syncStatus").textContent = "Syncing…";
  try {
    const driveFile = await storeGet("driveFile");
    if (!driveFile?.id) {
      setBusy(button, false);
      el("syncStatus").textContent = "Choose a file";
      return chooseDriveFile();
    }
    const token = await requestDriveToken();
    let base = brain.base || {};
    let local = brain.files || {};
    let stable = false;
    let merged = local;
    let conflicts = 0;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await getDriveMetadata(driveFile.id, token);
      const remote = await decryptEnvelope(await downloadDriveFile(driveFile.id, token), sessionPassphrase);
      const merge = await mergeFiles(base, local, remote);
      merged = merge.files;
      conflicts = Math.max(conflicts, merge.conflicts);
      const checked = await getDriveMetadata(driveFile.id, token);
      if (revisionToken(before) !== revisionToken(checked)) continue;

      await uploadDriveFile(driveFile.id, token, await encryptVault(merged, sessionPassphrase));
      const after = await decryptEnvelope(await downloadDriveFile(driveFile.id, token), sessionPassphrase);
      if (await sameJson(after, merged)) {
        stable = true;
        break;
      }
      local = merged;
    }

    brain.files = merged;
    if (stable) brain.base = merged;
    await persistBrain();
    renderBrain();
    updateDriveLabel();
    if (!stable) {
      el("syncStatus").textContent = "Try sync again";
      showMessage("Drive changed while syncing. Your phone copy is saved encrypted; press Sync now again to finish.", "error");
    } else {
      el("syncStatus").textContent = "Synced";
      showMessage(`Sync complete. ${Object.keys(merged).filter((name) => merged[name] !== null).length} files are current${conflicts ? `; ${conflicts} edit conflict(s) were saved under conflicts/` : ""}.`);
    }
  } catch (error) {
    el("syncStatus").textContent = "Needs attention";
    showMessage(error.message || String(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function disconnectDrive() {
  if (!window.confirm("Disconnect this phone from the selected Drive file? The encrypted file in Drive will remain.")) return;
  await storeDelete("driveFile");
  el("syncStatus").textContent = "Not connected";
  updateDriveLabel();
  showMessage("Disconnected. The Drive file has not been deleted.");
}

function setReminderDefault() {
  const due = new Date(Date.now() + 60 * 60 * 1000);
  due.setMinutes(due.getMinutes() - due.getTimezoneOffset());
  el("reminderWhen").value = due.toISOString().slice(0, 16);
}

function updateOnlineStatus() {
  el("onlineStatus").textContent = navigator.onLine ? "Online" : "Offline · saved here";
  el("onlineStatus").style.color = navigator.onLine ? "var(--green)" : "var(--amber)";
}

el("saveSettings").addEventListener("click", saveConfig);
el("unlockButton").addEventListener("click", async () => {
  const button = el("unlockButton");
  setBusy(button, true, "Unlocking…");
  try { await unlockBrain(); }
  catch (error) { el("unlockMessage").textContent = error.message || String(error); }
  finally { setBusy(button, false); }
});
el("createButton").addEventListener("click", async () => {
  const button = el("createButton");
  setBusy(button, true, "Creating…");
  try { await createBrain(); }
  catch (error) { el("unlockMessage").textContent = error.message || String(error); }
  finally { setBusy(button, false); }
});
el("lockButton").addEventListener("click", lockBrain);
el("saveCapture").addEventListener("click", () => saveCapture().catch((error) => showMessage(error.message || String(error), "error")));
el("addReminder").addEventListener("click", () => addReminder().catch((error) => showMessage(error.message || String(error), "error")));
el("reminderList").addEventListener("click", (event) => {
  const id = event.target?.dataset?.completeReminder;
  if (id) markReminderDone(id).catch((error) => showMessage(error.message || String(error), "error"));
});
el("chooseDriveFile").addEventListener("click", chooseDriveFile);
el("syncButton").addEventListener("click", syncNow);
el("disconnectDrive").addEventListener("click", () => disconnectDrive().catch((error) => showMessage(error.message || String(error), "error")));
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

loadConfigFields();
setReminderDefault();
updateDriveLabel();
updateOnlineStatus();
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
