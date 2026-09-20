# Dental Appointments — Backend

Node.js + Express backend for the `dental_appointments` MySQL schema (uploaded as-is — this project does not modify it). Covers authentication (patient self-registration + login) and CRUD for appointments and services, with role-based access.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create your `.env` file and fill in real MySQL credentials + a JWT secret:
   ```
   cp .env.example .env
   ```

3. Load the schema (creates the `dental_appointments` database, tables, the `sp_register_user` procedure, and seed data):
   ```
   mysql -u root -p < schema.sql
   ```
   Note: the seed data in this file inserts users with the literal password hash `<hashed_pw>` as a placeholder — those seed accounts won't be able to log in until you replace that with a real bcrypt hash, or just register fresh accounts through the API.

4. Start the server:
   ```
   npm run dev
   ```
   Runs at `http://localhost:5000` by default.

## Roles

`users.role` is one of `patient`, `employee`, `admin`. **Public registration only creates patient accounts** — a client should never be able to choose `employee` or `admin` for itself through an open signup form. Creating staff/admin accounts is intentionally left out of this basic scope; that should be a separate, admin-only protected endpoint added later.

## API Documentation

### Base URL

When running locally, the API is available at:

```
http://localhost:5000/api
```

The frontend should use the full API URL when it is served separately from the backend. The backend accepts JSON request bodies and enables CORS for browser requests.

### Endpoint Summary

| Method | Endpoint | Authentication | Description |
|---|---|---|---|
| POST | `/auth/register` | None | Creates a patient account. |
| POST | `/auth/login` | None | Verifies credentials and returns a JWT. |
| GET | `/services` | None | Lists available dental services. |
| POST | `/appointments` | Patient token | Creates a pending appointment. |
| GET | `/appointments` | Login token | Lists appointments allowed for the current user. |
| GET | `/appointments/:id` | Login token | Gets one appointment. |
| PUT | `/appointments/:id` | Login token | Updates an appointment according to the user's role. |
| PATCH | `/appointments/:id/reschedule` | Login token | Reschedules an appointment. |
| DELETE | `/appointments/:id` | Login token | Cancels an appointment. |
| GET | `/patients/:id` | Login token | Gets a patient record. |
| GET | `/reports/transactions` | Employee/admin token | Gets transaction totals and payment rows. |
| GET | `/reports/most-requested-services` | Employee/admin token | Gets services ranked by appointment count. |

`:id` is a path parameter. For example, `/appointments/12` refers to appointment `12`.

### Authentication Flow

1. The frontend sends the user's email and password to `/auth/login`.
2. The API returns a `token` and basic `user` information.
3. The frontend stores the token for the current session.
4. Protected requests send the token in the `Authorization` header.

The required header format is:

```
Authorization: Bearer <token>
```

### Frontend Request Examples

Define the API URL once in the frontend:

```javascript
const API_URL = 'http://localhost:5000/api';
```

#### Register

```javascript
const response = await fetch(`${API_URL}/auth/register`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      email: 'juan@example.com',
      phone: '09171234567',
      password: 'password123',
      sex: 'male'
   })
});

const data = await response.json();
if (!response.ok) {
   throw new Error(data.message || 'Registration failed');
}
```

#### Login and Save the Token

```javascript
const response = await fetch(`${API_URL}/auth/login`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({
      email: 'juan@example.com',
      password: 'password123'
   })
});

const data = await response.json();
if (!response.ok) {
   throw new Error(data.message || 'Login failed');
}

localStorage.setItem('userToken', data.token);
localStorage.setItem('currentUser', JSON.stringify(data.user));
```

#### Get Protected Data

```javascript
const token = localStorage.getItem('userToken');

const response = await fetch(`${API_URL}/appointments`, {
   headers: {
      Authorization: `Bearer ${token}`
   }
});

const appointments = await response.json();
if (!response.ok) {
   throw new Error(appointments.message || 'Could not load appointments');
}
```

#### Create an Appointment

```javascript
const token = localStorage.getItem('userToken');

const response = await fetch(`${API_URL}/appointments`, {
   method: 'POST',
   headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
   },
   body: JSON.stringify({
      service_id: 1,
      appointment_date: '2026-09-20',
      time_slot: '09:00:00',
      patient_note: 'Regular cleaning'
   })
});

const appointment = await response.json();
if (!response.ok) {
   throw new Error(appointment.message || 'Booking failed');
}
```

### HTTP Response Codes

| Status | Meaning | Common cause |
|---|---|---|
| `200 OK` | Request succeeded | Successful read or update. |
| `201 Created` | Resource created | Successful registration or appointment booking. |
| `400 Bad Request` | Invalid request | Required fields are missing or values are invalid. |
| `401 Unauthorized` | Login required | No Bearer token was provided. |
| `403 Forbidden` | Access denied | Token is invalid, expired, or lacks the required role. |
| `404 Not Found` | Resource not found | The requested record does not exist. |
| `409 Conflict` | Request conflicts with current data | Email already exists or a time slot is unavailable. |
| `500 Internal Server Error` | Server failure | Database or unexpected backend error. |

Most errors are returned as JSON:

```json
{
   "message": "Description of the error"
}
```

## Auth endpoints

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/register` | `{ first_name, last_name, email, phone?, password, sex?, birthday?, civil_status?, address? }` | Always creates a `patient`. Calls `sp_register_user`, then inserts the matching `patient_profiles` row. |
| POST | `/api/auth/login` | `{ email, password }` | Returns `{ token, user }`. Blocked if `account_status` is `suspended`. |

Send the token on every protected request:
```
Authorization: Bearer <token>
```

## Service endpoints

| Method | Endpoint | Auth | Body |
|---|---|---|---|
| GET | `/api/services` | none (public) | — |
| POST | `/api/services` | admin only | `{ label, price, icon?, is_available? }` |
| PUT | `/api/services/:id` | admin only | any of the above fields |
| DELETE | `/api/services/:id` | admin only | — (soft delete: sets `is_available = FALSE`) |

## Appointment endpoints (all require login)

| Method | Endpoint | Who | Behavior |
|---|---|---|---|
| GET | `/api/appointments` | any logged-in user | Patients see only their own; employees/admins see everyone's |
| GET | `/api/appointments/:id` | any logged-in user | Patients blocked from viewing others' appointments |
| POST | `/api/appointments` | patient only | `{ service_id, appointment_date, time_slot, patient_note? }`. Books for the logged-in patient, always starts `pending` |
| PUT | `/api/appointments/:id` | patient (own, pending only) or employee/admin | Patients can edit date/time/note pre-approval. Staff can set `employee_id`, `appointment_status`, `dentist_note`, `queue_status` |
| DELETE | `/api/appointments/:id` | patient (own) or employee/admin | Soft-cancels — sets `appointment_status = 'cancelled'`, doesn't delete the row |
| PATCH | `/api/appointments/:id/reschedule` | patient (own) or employee/admin | `{ appointment_date, time_slot }`; preserves the appointment status and returns `409` for an occupied assigned-employee slot |

Patients can reschedule pending or approved appointments. Completed and cancelled appointments cannot be cancelled or rescheduled. Employees and admins can reschedule any non-completed, non-cancelled appointment.

## Reports

Report endpoints require an employee or admin token. Dates use `YYYY-MM-DD` and are inclusive.

| Method | Endpoint | Query | Result |
|---|---|---|---|
| GET | `/api/reports/transactions` | `start_date?`, `end_date?` | Payment rows joined with appointment, patient, and service details, plus paid/refunded/net totals |
| GET | `/api/reports/most-requested-services` | `start_date?`, `end_date?`, `limit?` | Services ranked by non-cancelled appointment count; `limit` defaults to 10 and is capped at 100 |

Examples:

```
GET /api/reports/transactions?start_date=2026-09-01&end_date=2026-09-30
GET /api/reports/most-requested-services?limit=5
```

## Project structure

```
dental-backend/
├── config/db.js
├── controllers/
│   ├── authController.js
│   ├── appointmentController.js
│   └── serviceController.js
├── middleware/authMiddleware.js   # verifyToken + requireRole(...roles)
├── routes/
│   ├── authRoutes.js
│   ├── appointmentRoutes.js
│   └── serviceRoutes.js
├── app.js
├── server.js
└── schema.sql                     # your uploaded schema, unmodified
```

## Not yet built (natural next steps)

- Admin-only endpoint to create `employee`/`admin` accounts
- Payments, x-rays, messages, notifications CRUD
- Employee-side view of the daily queue (`queue_status`)
- Input validation library (e.g. `express-validator`) instead of manual checks
