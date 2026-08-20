# Maseray Temne Blogger — WhatsApp Contribution System

V1 foundation for member contributions, member-name lookup, payment records, and a Meta WhatsApp webhook.

## Run

- Node.js 18+
- `npm install`
- copy `.env.example` to `.env`
- set a strong `VERIFY_TOKEN`
- `npm start`
- open `http://localhost:3000`

## Features

- Member names, WhatsApp numbers, membership numbers and monthly contributions
- Contribution records and paid/unpaid status
- Member lookup by WhatsApp number
- Admin-style dashboard
- Meta WhatsApp webhook verification and incoming message endpoint
- SQLite for local development

## WhatsApp endpoints

- `GET /webhook/whatsapp` — Meta verification
- `POST /webhook/whatsapp` — incoming events

Add real WhatsApp credentials as deployment environment variables. Never commit access tokens or secrets to GitHub.

## Demo

A demo member is created on first start: `Demo Member`, phone `23200000000`, membership `MTB-001`, monthly contribution `100`.

## Next stage

Connect the selected Sierra Leone payment provider and Meta WhatsApp Cloud API after the core workflow is tested.