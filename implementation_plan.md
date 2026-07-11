# Integrate Estate Pay Frontend Design into EstatePay

## Background

The user has a polished React/TSX frontend design (Splash, Auth, HouseEntry, TenantDashboard, ManagerDashboard screens) that needs to be brought into the existing `estatepay` project.

The existing project is a **vanilla HTML/CSS/JS simulator** with:
- A 3-panel desktop layout (Device Simulators | Event Console | Firestore DB Viewer)
- A phone mockup on the left that renders the current basic mobile UI inside `#mobile-app-root`
- A rich simulated backend (Firestore, M-Pesa, WhatsApp bot)

The new design source is React/Tailwind — it cannot be dropped in directly. It must be **translated** to vanilla JS rendering.

## Strategy

The new frontend replaces the content of the existing **mobile app screen** (`#mobile-app-root`) inside the phone mockup. The outer 3-panel simulator shell stays intact. All 6 screens from the design are re-implemented as vanilla JS template functions that render HTML strings, mirroring the design's visual style exactly (same colors, layout, gradients, typography).

The existing backend simulation logic in `app.js` is **preserved and wired** into the new UI where applicable (payments → M-Pesa STK push, tenants list, etc.).

## Proposed Changes

---

### Core Files

#### [MODIFY] [style.css](file:///c:/Users/TOPHER/.gemini/antigravity-ide/scratch/estatepay/style.css)

Add new CSS section `/* === Mobile App Screens (New Design) ===` that styles all 6 screens:
- Mobile app root layout (full-screen within phone frame)
- Splash screen (radial gradient bg, logo, buttons)
- Auth screen (tabs, dark inputs, eye toggle)
- House entry with owner-generated household invite links
- Tenant dashboard (balance card, payment card, bottom nav, modal)
- Manager dashboard (stats grid, bar chart, tenant list, notices)
- Shared utilities (bottom nav, status badges, cards)

The new CSS uses the **exact same color palette** from the TSX design:
- Background: `#080C14`, `#111120`, `#0D0D1A`
- Primary: `#1565C0` / `#1976D2`
- Status: `#10B981` (paid), `#F59E0B` (pending), `#EF4444` (overdue)

#### [MODIFY] [app.js](file:///c:/Users/TOPHER/.gemini/antigravity-ide/scratch/estatepay/app.js)

Add a new section `// === MOBILE APP SCREEN RENDERER ===` with:

1. **Screen state manager** — `currentScreen` variable + `navigateTo(screen, data)` function
2. **Screen renderers** (one function per screen):
   - `renderSplash()` — logo, "Get Started", "Estate Manager Login"
   - `renderAuth(isManager)` — Login/Register tabs, dark inputs, password toggle
   - `renderHouseEntry()` — house number input, register toggle, invite-link join flow
   - `renderTenantDashboard(houseNumber)` — 4-tab (Home/Pay/History/Profile) with bottom nav + payment modal
   - `renderManagerDashboard()` — 4-tab (Overview/Tenants/Notices/Reports) with bar chart + tenant detail modal
3. **Event delegation** — single `click` + `input` listener on `#mobile-app-root` for all screen interactions
4. **Wire to existing backend** — pay button → triggers existing `initiateMpesaPayment()` logic; notices → log to event console

#### [MODIFY] [index.html](file:///c:/Users/TOPHER/.gemini/antigravity-ide/scratch/estatepay/index.html)

- The outer simulator shell stays **unchanged**
- Remove the old `<nav class="mobile-navbar">` hardcoded HTML (it's now rendered dynamically per screen)

---

## Visual Fidelity

The translated screens will match the design **pixel-for-pixel** in style:
- Same dark palette, gradients, border-radius, box-shadows
- Same bottom navigation with icon + label
- Same payment modal (slides up from bottom)
- Same manager stat grid + SVG bar chart
- Owner-generated household invite links replace OTP verification

## Verification Plan

### Manual Verification
1. Open `index.html` in browser
2. Phone mockup shows Splash screen — logo, two buttons
3. "Get Started" → Auth screen (Login/Register tabs)
4. Login → House Entry → register a new house or join with an owner invite link → Tenant Dashboard
5. Tenant Dashboard: navigate all 4 tabs, open payment modal, confirm payment → success toast
6. "Estate Manager Login" → Manager Dashboard: check all 4 tabs (Overview, Tenants, Notices, Reports)
7. Outer simulator (Event Console, DB Viewer, Admin Panel) still works correctly

> [!NOTE]
> The existing WhatsApp bot, M-Pesa USSD dialog, DB viewer and admin panel are untouched.
