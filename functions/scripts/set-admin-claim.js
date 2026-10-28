#!/usr/bin/env node
'use strict';

// Run only from a trusted workstation with GOOGLE_APPLICATION_CREDENTIALS pointing to a
// service-account JSON file held OUTSIDE this repository. Never upload that file to GitHub.
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const projectId = 'pashughar-25ecc';
const uid = String(process.argv[2] || '').trim();

if (!uid) {
  console.error('Usage: node scripts/set-admin-claim.js FIREBASE_AUTH_UID');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a trusted service-account JSON path outside this project.');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId });
(async () => {
  const user = await getAuth().getUser(uid);
  await getAuth().setCustomUserClaims(uid, { ...(user.customClaims || {}), admin: true });
  console.log(`Admin claim assigned to ${uid}. Sign out and sign in again to refresh the token.`);
})().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
