# Verification

1. `cd frontend && npx tsc --noEmit && npx vite build`.
2. Start a scratch engine serving the build (`FORMPDF_DIST`), with a scratch `FORMPDF_DATA_DIR`.
3. Python Playwright with the preinstalled Chromium (never `playwright install`): CDP `Emulation.setCPUThrottlingRate {rate: 4}` and `Network.emulateNetworkConditions` (150 ms latency, about 1.5 Mbps), a hard reload, a buffered `PerformanceObserver` for `layout-shift`, and console error collection.
4. Drive the flow you changed with real clicks (a programmatic `select_option` is not user input and shows false shifts; click the dropdown instead). Read every screenshot.
5. The bar: zero console errors, zero layout shift. A crop resizing its own pages is the only accepted shift.
6. Agents: initialize, tools/list and tools/call over HTTP, once through the stdio bridge, with the window open (consent appears, the change lands live, undo returns) and without it (a changing call is refused until agents are allowed; reading and an allowed setting work).
7. Stop the scratch engine by PID.
