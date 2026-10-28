# Pashughar — Firebase-connected marketplace starter

Pashughar is a responsive Nepal-focused marketplace for live livestock, pets & supplies, meat & poultry, animal products, and animal care. This package connects the front end to the Firebase project `pashughar-25ecc`. It does **not** enable Firebase Storage or deploy anything to your project automatically.

## What is wired in this version

- Firebase Authentication: Google sign-in, email/password account creation, sign-in, password-reset email, and sign-out.
- Firestore live catalogue: the visitor catalogue reads approved products; retailer dashboards read their own shop/products/orders; the admin dashboard reads protected management data after a trusted admin claim is verified.
- Shop onboarding: retailer profile records are stored under the authenticated UID, start with `pending`, and are not allowed to publish until approved.
- Product management: verified retailer create/update/delete operations use Firestore Security Rules; image files are not uploaded. Use public HTTPS image URLs.
- Admin moderation: shop and product verification, suspension, restoration, and removal use admin-only Firestore rules and the server-assigned `admin` custom claim.
- Backend starter: trusted callable Cloud Functions handle guest checkout with server-calculated prices, transactional stock decrement, per-retailer order records, checkout idempotency, public product reports, and report moderation.
- UI behaviour: product stock of zero renders Sold Out and disables add-to-cart; light/dark mode, search, categories, cart and wishlist remain available.

## Important limits for your current plan

- **Firebase Storage is intentionally not configured or used.** No paid upgrade or bucket setup is part of these instructions, and `firebase.json` has no Storage deployment target. The included `storage.rules` deny all access if Storage is later enabled accidentally. The retailer form accepts public HTTPS image URLs only. A visitor's browser must be able to access the image URL directly.
- **Cloud Functions are included but not yet deployed.** Guest checkout, public reporting, report moderation, and retailer order-status updates will not work until functions are deployed. Current Firebase project plan is Spark; deploying Cloud Functions may require switching to Blaze and enabling billing. Do not upgrade just to test the site. You can test Firebase Authentication, shop applications, products, and admin shop/product moderation first.
- **Online payments are not integrated.** COD/contact-retailer choices only record an offline arrangement; no money is collected.
- **No live Firebase test was run from this ZIP.** Syntax and project-file checks are done locally, but first-run access, rules, OAuth domain and deployment must be verified in your own Firebase project.
- This is a development starter, not yet ready to handle real commercial transactions without further testing, legal policy, support procedures, backups, and abuse monitoring.

## Run on Windows

1. Extract this ZIP to a normal folder, e.g. `C:\Users\YourName\Desktop\Pashughar`.
2. Open that folder in File Explorer.
3. In the address bar type `cmd` and press Enter.
4. Run:

   ```bat
   py -m http.server 8080
   ```

5. Open `http://localhost:8080` in Brave/Chrome. Do not double-click `index.html`, because Firebase browser modules need an HTTP origin.

Firebase's public web configuration is in `js/firebase.js`. It is normal for the Firebase web API key to appear in a website; do **not** put a service-account JSON, private keys, payment secrets, or Admin SDK credentials in browser JavaScript.

## First deployment without Storage / Functions

The Firebase Console currently has Firestore in production mode. The website cannot read/write records until the matching rules in this package are deployed.

1. Install Node.js LTS and Firebase CLI if not already installed.
2. Open Command Prompt in the extracted project folder.
3. Sign in to Firebase and deploy only Hosting + Firestore rules:

   ```bat
   npm install -g firebase-tools
   firebase login
   firebase use pashughar-25ecc
   firebase deploy --only hosting,firestore:rules
   ```

   The `.firebaserc` file already selects `pashughar-25ecc`. The deployment command includes only Hosting + Firestore rules; Storage has no deployment target and Functions are excluded.

4. Check Firebase Console → Authentication → Settings → Authorized domains. `localhost`, `pashughar-25ecc.firebaseapp.com`, and `pashughar-25ecc.web.app` should be listed. Add a production domain later when you actually use one.
5. Open Hosting URL or `http://localhost:8080` and test customer browsing, retailer account sign-up, shop registration, and product entry after shop approval.

If `firebase deploy` asks to change billing, stop and review the prompt; do not accept an upgrade just to deploy the current Hosting + rules setup.

## Create the administrator account safely

Admin is **not** created by a front-end password, and no account can grant admin status to itself.

1. Create/sign in to the administrator's Firebase Authentication account (Google or email/password).
2. In Firebase Console → Authentication → Users, copy that user's **UID**.
3. A trusted Admin SDK environment must assign the custom claim `admin: true`. This ZIP includes `functions/scripts/set-admin-claim.js` for a trusted workstation. It requires a service-account credential file that you obtain through the Google Cloud/Firebase IAM process and keep **outside** this project folder. Never commit or send this credential file.
4. In Command Prompt, set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the file's full path, then run from the `functions` folder:

   ```bat
   npm install
   node scripts/set-admin-claim.js YOUR_AUTH_UID
   ```

5. Sign out and sign back in to refresh the authentication token. Visit `#admin`. An ordinary retailer account will not be allowed into the control panel.

Do not create admin claim setting code in `js/app.js` or let a user choose their own role in a form.

## Cloud Functions (optional; review billing before deploying)

The backend in `functions/index.js` (configured for the same `asia-south2` region as Firestore, using the Node.js 22 runtime) validates product prices and retailer status from Firestore, decrements stock within a transaction, stores one order and per-retailer suborders, and accepts public reports through callable functions. A retry with the same checkout form request ID returns the original order instead of decrementing stock twice.

Only consider deployment after checking the current Firebase pricing/plan requirement and enabling billing knowingly:

```bat
cd functions
npm install
cd ..
firebase deploy --only functions
```

Do not add a Storage deployment target unless you intentionally decide to enable Storage later. If you do not want Blaze/billing, leave Functions undeployed and don't represent guest checkout or public reports as available. The front-end displays the backend dependency, and shop/product moderation is implemented directly with rules-protected Firestore operations.

## Firestore collections used

| Collection | Use | Client access |
|---|---|---|
| `retailers` | Shop application and verification status | Owner reads/updates permitted profile fields; admin moderates |
| `products` | Approved catalogue and retailer stock | Public reads approved items; owner manages their own listing; admin moderates |
| `orders` | Master checkout records | Customer/admin reads; trusted server creates |
| `retailerOrders` | Shop-specific order view | Assigned retailer/admin reads; trusted server updates |
| `reports` | Private customer reports and history | Admin reads; trusted server creates/moderates |
| `orderRequests` | Server-only checkout idempotency records | Client access denied |
| `reportDedupe`, `reportRateLimits` | Server-only anti-duplicate/rate-limit records | Client access denied |
| `auditLogs` | Administrative audit scaffold | Read/write denied from browser; server-side logs only |

The catalogue query filters `status == 'approved'`, and Firestore Rules enforce ownership / privileged actions. Never replace them with `allow read, write: if true`.

## Local fallback demo

If Firebase configuration is removed intentionally, the original local prototype can still be used with demo accounts `retailer` / `retailer` and `admin` / `admin`. Those credentials are for offline testing only. In this packaged version, `js/firebase.js` is configured for your real Firebase project, so the web app uses Firebase Authentication instead of these credentials.

## Project files

```text
pashughar/
├── index.html
├── css/styles.css
├── js/app.js
├── js/store.js
├── js/firebase.js
├── firestore.rules
├── storage.rules                 # not deployed by the default command
├── functions/index.js            # optional backend, not deployed by default
├── functions/scripts/set-admin-claim.js
├── functions/package.json
├── firebase.json
├── .firebaserc
├── package.json
└── README.md
```

## Before a real public launch

Test role boundaries and all rules with a separate non-admin account; check email/password reset and Google OAuth; deploy rules before opening the site; verify shop suspension and product visibility; test stock concurrency, duplicate checkout and cancellation; enable App Check and abuse monitoring; decide delivery, refunds, customer support, data retention, legally reviewed privacy/terms, animal welfare and listing restrictions; and configure export/restore backups.
