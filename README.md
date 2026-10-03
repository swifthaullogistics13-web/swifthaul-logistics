# SwiftHaul Logistics

A deployable courier tracking web app with:
- Public tracking page
- SQLite shipment database
- Automatic tracking-number generation
- Admin shipment creation
- Admin tracking-status updates
- Responsive interface

## Run locally

Requirements: Node.js 18+.

```bash
npm install
ADMIN_KEY="replace-with-a-long-random-secret" npm start
```

Open http://localhost:3000

On Windows PowerShell:
```powershell
$env:ADMIN_KEY="replace-with-a-long-random-secret"
npm start
```

Admin:
http://localhost:3000/admin.html

## Production notes

1. Use a strong `ADMIN_KEY` environment variable.
2. Put the app behind HTTPS.
3. Use a production database/backup strategy if volume grows.
4. Replace the example support email/domain with your actual business details.
5. Add your real company registration, address, phone, privacy policy, terms, and shipping conditions before accepting customers.
6. Never create tracking records for shipments that do not actually exist.

## Suggested deployment

This Node/Express app can be deployed to a Node-compatible host such as Render, Railway, Fly.io, or a VPS. For a public production deployment, attach a domain you own and configure HTTPS.
