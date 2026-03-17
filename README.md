# loondry-backend

Express + TypeScript backend scaffold for Loondry.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

## Starter endpoints

- `GET /health`
- `GET /api/apartments`
- `GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&propertyId=`
- `GET /api/tasks?date=YYYY-MM-DD&propertyId=`
- `POST /api/tasks/:id/start`
- `POST /api/tasks/:id/complete`
- `POST /api/tasks/:id/assign` `{ "cleaner": "Giulia" }`

Data is in-memory demo data; swap in DB later.
