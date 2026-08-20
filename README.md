# Maseray Temne Blogger — WhatsApp Contribution System

A Node.js/SQLite foundation for member contributions, member-name lookup, payment records, and a Meta WhatsApp webhook.

## Run locally

- Node.js 18+
- `npm install`
- copy `.env.example` to `.env`
- set a strong `VERIFY_TOKEN`
- `npm start`
- open `http://localhost:3000`

Run the automated smoke test with:

```bash
npm test
```

## Features

- Member names, WhatsApp numbers, membership numbers and monthly contributions
- Contribution records with paid/unpaid status and payment references
- Member lookup by WhatsApp number
- Dashboard showing active members and paid/unpaid totals
- Meta WhatsApp webhook verification
- Optional WhatsApp replies that identify a registered member by phone number
- Optional `X-Hub-Signature-256` webhook verification using `WHATSAPP_APP_SECRET`
- SQLite for local development
- GitHub Actions smoke testing on pushes and pull requests

## WhatsApp endpoints

- `GET /webhook/whatsapp` — Meta verification
- `POST /webhook/whatsapp` — incoming events
- `GET /api/health` — health check

For WhatsApp replies, configure `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_GRAPH_VERSION`. If credentials are not configured, the webhook still accepts and logs incoming messages without attempting a reply.

Never commit access tokens, app secrets, or `.env` files to GitHub.

## Demo

A demo member is created on first start: `Demo Member`, phone `23200000000`, membership `MTB-001`, monthly contribution `100`.

## Current scope

The member/contribution workflow and WhatsApp member lookup are implemented. A real Sierra Leone payment-provider integration and production hosting still require the provider account/API credentials and deployment environment.
