# Finance Decision System (V3)

Fresh implementation of a modular finance decision system with:
- Centralized core services (auth, storage, import, sync, analytics)
- Professional responsive UI for desktop and mobile
- Local-first persistence using browser `localStorage`
- Google Sheets cloud sync via Apps Script endpoint
- Admin/User login from separate password sheet
- Brokerage transaction CSV import
- Login/Logout session flow
- GitHub Pages deployment workflow

## Stack
- Vite + TypeScript
- Vanilla TypeScript SPA architecture

## Run locally
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
npm run preview
```

## Google Sheets sync contract
App uses one fixed script URL for all users.

Configured values:
- Spreadsheet ID: stored in Apps Script Properties (private)
- Web App URL: `https://script.google.com/macros/s/AKfycbzQrRH_salSv5B1dQExYZbOJfKU9denSIcJ8Edk44UOXRMVHIAkw2E-NKr1vxXbFDdI/exec`

Current API contract:
- `POST` login: `{ mode: "login", loginId, password }`
- `POST` register request: `{ mode: "register_user", name, loginId, password, email? }`
- `POST` list pending (admin): `{ mode: "list_pending", adminLoginId, adminPassword }`
- `POST` approve user (admin): `{ mode: "approve_user", adminLoginId, adminPassword, requestId, role }`
- `POST` reject user (admin): `{ mode: "reject_user", adminLoginId, adminPassword, requestId, note? }`
- `POST` push snapshot: `{ mode: "push", userId, payload, pushedAt }`
- `GET` pull snapshot: `?mode=pull&userId=<id>`

## Admin/User login setup (zero cost)
1. Open your Google Sheet (Spreadsheet ID is kept private in Apps Script Properties).
2. Open `Extensions -> Apps Script`.
3. Copy-paste [docs/apps-script.gs](docs/apps-script.gs) into script editor and save.
4. In **Project Settings** → **Script Properties**, add `SPREADSHEET_ID` with your Google Sheet ID.
4. Deploy as Web App:
   - Execute as: `Me`
   - Who has access: `Anyone`
5. Keep the same deployed URL as configured in the frontend constants.
6. Run helper once from Apps Script editor:
   - `createAdminDirect("Your Name", "your_login_id", "your_password", "your@email.com")`
7. Users register from app, then admin approves from admin panel.

Sheets used by script:
- `Users` for approved credentials and roles
- `PendingUsers` for new registration requests
- `Snapshots` for cloud state backups
- `AdminSessions` for admin approval token sessions (no repeated password prompt)

## Brokerage CSV headers
Supported header aliases include:
- Date: `date`, `trade_date`, `timestamp`
- Symbol: `symbol`, `ticker`, `security`
- Side: `side`, `type`, `action` (`BUY/SELL` or `B/S`)
- Quantity: `quantity`, `qty`, `units`
- Price: `price`, `avg_price`, `trade_price`
- Fees (optional): `fees`, `fee`, `charges`, `brokerage`

## GitHub Pages deployment
GitHub Action file: `.github/workflows/deploy.yml`

Steps:
1. Push this repo to GitHub on branch `main`.
2. In repository settings, set `Pages` source to `GitHub Actions`.
3. Every push to `main` builds and deploys automatically.

## Suggested next milestones
1. Add user deactivate/reactivate actions for admin.
2. Add password reset flow with one-time token sheet.
3. Add broker-specific import adapters (Zerodha, Groww, Upstox, etc.).
4. Add decision engine signals (risk score, allocation drift, rule checks).
