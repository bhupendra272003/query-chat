# Query Chat

A private, WhatsApp/Instagram-DM-style chat website with admin-approved accounts, real-time one-to-one and group messaging, admin-managed accounts, and file attachments.

## Features
- One administrator login configured through environment variables
- User registration with pending / approved / rejected states
- Private conversation between each approved user and the administrator
- Private one-to-one user-to-user messaging between approved members
- Member directory with a New Chat entry point and real-time direct messages
- Admin can set a temporary password for any approved member; the member must change it at next login
- Admin-created groups with approved-member selection and group messaging
- Group spaces appear only for members invited by the administrator
- Direct conversations are restricted to the two approved participants
- Modern responsive admin and user workspaces
- Real-time message updates using Socket.IO
- Private file attachments in admin-user conversations for Python, SQL, PBIX/PBIT, Jupyter notebooks, CSV/Excel, JSON, Parquet, documents, images, ZIP and common source files (up to 50 MB per file)
- Private Supabase Storage bucket; files are downloaded only through authenticated routes
- PostgreSQL storage for accounts, messages, file metadata, and sessions
- Render Blueprint included for deployment

## Deploy on Render + Supabase

1. Create a Supabase project.
2. In Supabase, copy the Project URL and the `service_role` secret key from Project Settings / API. Keep the key private.
3. In Supabase Connect, copy the **Session pooler** connection string using port `5432` (not the transaction pooler on port `6543`).
4. Push this project to a GitHub repository.
5. In Render, create a new Blueprint and select this repository. Render reads `render.yaml` and creates the web service.
6. In the Render service environment, set the secret values requested by the Blueprint:
   - `ADMIN_PASS`: a unique password of at least 14 characters
   - `DATABASE_URL`: the Supabase Session pooler connection string
   - `SUPABASE_URL`: the Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role secret
7. Deploy. On first startup, the app creates its required PostgreSQL tables and the private `query-chat-files` Storage bucket.
8. Open the deployed URL and sign in as admin using username `admin` and the `ADMIN_PASS` you set. Users can register and will remain pending until approved.

## Local development

1. Install Node.js 22 or newer.
2. Copy `.env.example` to `.env` and fill in the required values.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

## Important security notes

- Never commit `.env` or expose the Supabase `service_role` key in browser code or public messages.
- Use a long, unique administrator password. The app requires at least 14 characters.
- Render's free web service may sleep when idle. Free-tier services and storage quotas may change; this setup is suitable for a low-cost test/demo, not a guaranteed always-on production service.
- Test registration, approval, messaging, and file transfer after deployment before sharing the site.
