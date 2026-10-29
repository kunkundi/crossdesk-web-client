"use strict";

const fs = require("node:fs");
const path = require("node:path");

const version = process.argv[2];
if (process.argv.length !== 3 || !/^\d[\dA-Za-z.-]{0,63}$/.test(version || "")) {
  console.error("Usage: node scripts/set-version.js <version>, e.g. 2026.09.24.1");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const clientPath = path.join(root, "web_client.js");
const indexPath = path.join(root, "index.html");
const client = fs.readFileSync(clientPath, "utf8");
const declaration = /^const WEB_CLIENT_VERSION = "[^"]+";$/m;
if (!declaration.test(client)) throw new Error("Missing WEB_CLIENT_VERSION declaration");

let html = fs.readFileSync(indexPath, "utf8");
for (const asset of ["styles.css", "control.js", "turn_credentials.js", "file_download.js", "file_transfer.js", "clipboard.js", "web_client.js", "session_controls.js"]) {
  const attribute = asset.endsWith(".css") ? "href" : "src";
  const pattern = new RegExp(`${attribute}="${asset.replace(/\./g, "\\.")}(?:\\?[^\"]*)?"`, "g");
  const matches = html.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(`Expected one reference to ${asset}`);
  html = html.replace(pattern, `${attribute}="${asset}?v=${version}"`);
}

// Validate both inputs before writing either file.
fs.writeFileSync(clientPath, client.replace(declaration, `const WEB_CLIENT_VERSION = "${version}";`));
fs.writeFileSync(indexPath, html);
console.log(`Web client version and asset cache keys updated to ${version}`);
