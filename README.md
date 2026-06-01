# Task Email Scheduler

This project now has two modes:

- `server-cloud.js`: multi-user platform with Google sign-in, synced schedules, SQLite database, and company-email reminders.
- `server.js`: older personal local version for one fixed schedule.

## Run the multi-user platform locally

```powershell
$env:ALLOW_DEV_LOGIN='1'
node server-cloud.js
```

Then open:

```text
http://localhost:3000/platform.html
```

Developer login is only for local testing. Real Google sign-in needs `GOOGLE_CLIENT_ID`.

## Production environment variables

Set these on your hosting provider:

- `GOOGLE_CLIENT_ID`: Google OAuth web client ID.
- `SESSION_SECRET`: long random string for signing login cookies.
- `COMPANY_SMTP_HOST`: SMTP host for the company sender, for example `smtp.gmail.com`.
- `COMPANY_SMTP_PORT`: usually `465`.
- `COMPANY_SMTP_USER`: `yashamantrial@gmail.com`.
- `COMPANY_SMTP_PASSWORD`: app password or SMTP password for the company sender.
- `COMPANY_EMAIL_FROM`: `yashamantrial@gmail.com`.

Users do not enter sender email settings. If a user signs in as `someone@gmail.com`, reminders are sent to `someone@gmail.com` from `yashamantrial@gmail.com`.

## Google sign-in setup

1. Create a Google Cloud project.
2. Configure the OAuth consent screen.
3. Create an OAuth Client ID with application type `Web application`.
4. Add your deployed URL to Authorized JavaScript origins, for example `https://task-email-scheduler.onrender.com`.
5. Copy the client ID into `GOOGLE_CLIENT_ID`.

## Database

The app uses SQLite at `data/task-scheduler.sqlite`. On a real host, attach persistent disk storage to the `data` folder. A `render.yaml` blueprint is included for Render with a persistent disk.

## Email reminders

The cloud server checks reminders every minute. Each user has:

- Their own task schedule.
- Their own task timings.
- Their own reminder lead time.
- Their own time zone.

The server avoids duplicate sends using the `sent_reminders` database table.

## Deploy with GitHub + Render

GitHub Pages is not enough for this multi-user version because it cannot run a backend or database. Use GitHub for the repo and deploy the backend from GitHub to Render, Railway, Fly.io, or another Node host.

Recommended path:

1. Create a GitHub repository and upload this folder.
2. Create a Render account.
3. Create a new Blueprint deployment from the GitHub repo using `render.yaml`.
4. Add the production environment variables above.
5. Add your Render URL to Google OAuth Authorized JavaScript origins.
6. Open the Render URL and sign in with Gmail.

## Personal local Gmail setup

This applies only to the older `server.js` personal version.

```powershell
node server.js
```

The personal app sends email through Gmail SMTP. Gmail does not allow normal account passwords for this, so use an app password.

1. Turn on 2-Step Verification for your Google account.
2. Create a Gmail app password in your Google account security settings.
3. Open the site.
4. Add your sender Gmail, recipient Gmail, app password, and keep the reminder lead time at `15`.
5. Click `Save`, then `Send test`.

The reminders are sent only while `node server.js` is running. Settings are stored locally in `data/settings.json`; the app password is not written into the source code.

If you see `SMTP 535` or `BadCredentials`, Gmail rejected the login. Generate a fresh app password from the same Gmail account shown in `Sender Gmail`, paste it into the password box, click `Save`, and then click `Send test` again. App passwords require 2-Step Verification and can be revoked if you change your Google password.

Google help: https://support.google.com/accounts/answer/185833

## Optional static GitHub Pages version

This repo still includes the earlier static GitHub Pages workflow. Use it only for the personal/static version. It does not provide Google sign-in, user databases, or synced schedules.

1. Create a new GitHub repository named `dsa-reminder-site`.
2. Upload or push all files in this folder to the repository.
3. In the repository, go to `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.
4. Add these secrets:
   - `GMAIL_USER`: sender Gmail, for example `yashaman5885@gmail.com`
   - `GMAIL_APP_PASSWORD`: the 16-character Gmail app password for that sender account
   - `REMINDER_TO`: recipient Gmail, for example `yashaman305@gmail.com`
5. Go to `Actions` and run `Deploy website to GitHub Pages`.
6. Open the Pages URL shown by the workflow.

The hosted website is static, so it does not store Gmail credentials in the browser. Email reminders are sent by the `Send task reminders` GitHub Actions workflow. The workflow is set for India time and sends reminders 15 minutes before each task.

For the real multi-user product, deploy `server-cloud.js` instead.

## Change tasks

Edit `data/tasks.json`. Times use 24-hour format. Use values like `23:00` and `24:15` for a block that crosses midnight.
