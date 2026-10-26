# Study Planner (desktop app)

Electron app. The page is in `renderer/`, the window and file/calendar access in `main.js`.

- `npm start` – run the app from source
- `npm run dist` – build the installer into `dist/Study-Planner-Setup-<version>.exe`

Bump `version` in `package.json` before building a new installer to send out.
Installing a newer version over an old one keeps the user's data.

User data is stored in `%APPDATA%\Study Planner` (`planner.json`, `settings.json`, `calendar-cache.json`).

If `npm start` fails with `Cannot read properties of undefined (reading 'handle')`, the terminal has
`ELECTRON_RUN_AS_NODE` set (VS Code's integrated terminal can do this). Run it from a normal terminal,
or clear the variable first: `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell).
