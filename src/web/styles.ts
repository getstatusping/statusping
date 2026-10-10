/**
 * Styles follow shadcn/ui's default "neutral" theme (https://ui.shadcn.com/docs/theming):
 * the same CSS variables, radius scale and component conventions (Card, Alert, Badge, Button,
 * Input, Table, DropdownMenu, Popover). Status colours are the only accents.
 */
export const STYLES = `
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  /* Status colours (not part of shadcn's palette). */
  --success: oklch(0.627 0.17 149);
  --warning: oklch(0.769 0.188 70.08);
  --nodata: oklch(0.922 0 0);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --success: oklch(0.696 0.17 162.48);
    --nodata: oklch(0.269 0 0);
      color-scheme: dark;
  }
}

* { box-sizing: border-box; border-color: var(--border); }
body { margin: 0; background: var(--background); color: var(--foreground); -webkit-font-smoothing: antialiased;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 4px; }
ul { list-style: none; margin: 0; padding: 0; }
.wrap { max-width: 860px; margin: 0 auto; padding: 0 16px; }
main.wrap { padding-top: 32px; padding-bottom: 24px; }
.muted { color: var(--muted-foreground); }
.small { font-size: 13px; }
.nowrap { white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── Header bar ─────────────────────────────────────────────────────────────── */
.site-header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--background) 85%, transparent); backdrop-filter: blur(8px); }
.site-header-inner { display: flex; align-items: center; gap: 12px; height: 56px; }
.account { margin-left: auto; display: flex; align-items: center; gap: 12px; }
@media (max-width: 480px) { .account-email { display: none; } }

/* ── Buttons (shadcn Button) ────────────────────────────────────────────────── */
.btn-outline, .btn-primary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px;
  padding: 0 16px; border-radius: calc(var(--radius) - 2px); font: inherit; font-size: 14px; font-weight: 500; white-space: nowrap;
  cursor: pointer; transition: background-color .15s, color .15s; outline: none; }
.btn-outline { border: 1px solid var(--border); background: var(--background); color: var(--foreground);
  box-shadow: 0 1px 2px rgb(0 0 0 / .05); }
.btn-outline:hover { background: var(--accent); color: var(--accent-foreground); text-decoration: none; }
.btn-primary { border: 0; background: var(--primary); color: var(--primary-foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .05); }
.btn-primary:hover { background: color-mix(in oklab, var(--primary) 90%, transparent); text-decoration: none; }
.btn-outline:focus-visible, .btn-primary:focus-visible { box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent); }

/* ── Page heading + page dropdown ───────────────────────────────────────────── */
.head { margin-bottom: 24px; }
.head h1 { font-size: 30px; line-height: 1.2; font-weight: 600; letter-spacing: -0.025em; margin: 0;
  display: flex; align-items: center; gap: 10px; min-width: 0; }
.desc { margin: 8px 0 0; color: var(--muted-foreground); font-size: 16px; }
.crumbs { margin-bottom: 12px; font-size: 14px; }
.crumbs a { color: var(--muted-foreground); }
.crumbs a:hover { color: var(--foreground); text-decoration: none; }

.switcher { position: relative; display: inline-block; max-width: 100%; }
.switcher summary { list-style: none; cursor: pointer; border-radius: calc(var(--radius) - 2px); color: var(--foreground); text-decoration: none; }
.switcher summary::-webkit-details-marker { display: none; }
.switcher summary:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent); }
.switcher .chevron { flex: none; color: var(--muted-foreground); transition: transform .15s; }
.switcher[open] .chevron { transform: rotate(180deg); }
.switcher summary:hover .chevron { color: var(--foreground); }

/* shadcn DropdownMenu */
.switcher-menu { position: absolute; z-index: 25; top: calc(100% + 6px); left: 0; min-width: 224px; max-width: min(320px, calc(100vw - 32px));
  max-height: 60vh; overflow-y: auto; padding: 4px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
  background: var(--popover); color: var(--popover-foreground);
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1); }
.menu-label { padding: 6px 8px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.menu-sep { height: 1px; margin: 4px -4px; background: var(--border); }
.menu-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: calc(var(--radius) - 4px);
  font-size: 14px; color: inherit; outline: none; }
.menu-item:hover, .menu-item:focus-visible { background: var(--accent); color: var(--accent-foreground); text-decoration: none; }
.menu-check { display: inline-flex; width: 16px; flex: none; }
.menu-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-hint { display: inline-flex; margin-left: auto; color: var(--muted-foreground); }

/* ── Status banner ──────────────────────────────────────────────────────────── */
.status { --tone: var(--success); margin-bottom: 24px; overflow: hidden; border: 1px solid color-mix(in oklab, var(--tone) 55%, var(--border));
  border-radius: var(--radius); background: var(--card); color: var(--card-foreground); }
.status.down { --tone: var(--destructive); } .status.late { --tone: var(--warning); }
.status-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: color-mix(in oklab, var(--tone) 18%, var(--card)); }
.status-head h2 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; color: var(--foreground); }
.status-icon { display: inline-flex; flex: none; color: var(--tone); --status-icon-fg: var(--card); }
.status-icon.down { color: var(--destructive); } .status-icon.late { color: var(--warning); }
.status-body { margin: 0; padding: 14px 20px; font-size: 15px; }
.status .stale-warning { padding: 0 20px 14px; margin: 14px 0 0; }
.status-chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.chip { --chip: var(--destructive); display: inline-flex; align-items: center; padding: 3px 10px; border-radius: calc(var(--radius) - 4px);
  border: 1px solid color-mix(in oklab, var(--chip) 45%, transparent); background: color-mix(in oklab, var(--chip) 14%, transparent);
  color: color-mix(in oklab, var(--chip) 75%, var(--foreground)); font-size: 14px; font-weight: 500; }
.chip.late { --chip: var(--warning); }
.chip:hover { text-decoration: none; background: color-mix(in oklab, var(--chip) 22%, transparent); }
.status-incidents { display: grid; gap: 8px; padding: 8px; }
.incident { padding: 14px 16px; border-radius: calc(var(--radius) - 2px); background: var(--muted); }
.incident-title { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 15px; }
.incident-title .status-icon svg { width: 18px; height: 18px; }
.incident-title a { color: var(--foreground); }
.incident-body { margin: 6px 0 0 28px; font-size: 15px; line-height: 1.55; color: var(--foreground); overflow-wrap: anywhere; }
.incident-meta { display: flex; flex-wrap: wrap; gap: 0 8px; margin: 8px 0 0 28px; font-size: 14px; color: var(--muted-foreground); }
.stale-warning { font-size: 14px; color: var(--destructive); }

/* ── Cards (shadcn Card) ────────────────────────────────────────────────────── */
.card { margin-bottom: 24px; padding: 24px; border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px);
  background: var(--card); color: var(--card-foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .05); }
.card h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; line-height: 1; letter-spacing: -0.01em; }

.mons > li + li { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
.mon-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.mon-name { font-weight: 500; color: var(--foreground); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted-foreground); }
.dot.up { background: var(--success); } .dot.down { background: var(--destructive); } .dot.late { background: var(--warning); }

/* shadcn Badge (outline) with a status dot */
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border: 1px solid var(--border);
  border-radius: calc(var(--radius) - 2px); font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; color: var(--foreground); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); }
.pill.up::before { background: var(--success); } .pill.down::before { background: var(--destructive); } .pill.late::before { background: var(--warning); }

/* Uptime bars */
.bars { display: flex; gap: 2px; height: 32px; }
.bar { flex: 1; min-width: 2px; border-radius: 2px; background: var(--nodata); position: relative; }
.bar.up { background: var(--success); } .bar.partial { background: var(--warning); } .bar.down { background: var(--destructive); }
.bar[tabindex] { cursor: pointer; outline: none; }
.bar[tabindex]:hover, .bar[tabindex]:focus { box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--ring); }
.bar-legend { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
@media (max-width: 600px) { .bar:nth-child(-n+60) { display: none; } .bar-legend span:first-child { visibility: hidden; } }

/* Bar popover (shadcn Popover) */
.pop { display: none; position: absolute; z-index: 20; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  width: 300px; max-width: calc(100vw - 32px); padding: 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
  background: var(--popover); color: var(--popover-foreground); text-align: left; cursor: default; font-size: 13px; line-height: 1.45;
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / .1), 0 2px 4px -2px rgb(0 0 0 / .1); }
.pop.pop-l { left: -4px; transform: none; } .pop.pop-r { left: auto; right: -4px; transform: none; }
.bar:hover > .pop, .bar:focus > .pop, .bar:focus-within > .pop { display: block; }
.pop-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.pop-head strong { font-weight: 600; }
.pop-total { font-weight: 500; color: var(--destructive); white-space: nowrap; }
.pop-sub { display: block; margin-top: 2px; font-size: 12px; color: var(--muted-foreground); }
.pop-list { display: block; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.pop-item { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; padding: 4px 0; }
.pop-item + .pop-item { border-top: 1px solid var(--border); }
.pop-dur { grid-row: span 3; min-width: 44px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--warning); }
.pop-dur.ongoing { color: var(--destructive); }
.pop-what { overflow-wrap: anywhere; }
.pop-when, .pop-detail, .pop-more { font-size: 12px; color: var(--muted-foreground); }
.pop-detail { overflow-wrap: anywhere; }
.pop-more { display: block; padding-top: 4px; }

/* ── Monitor page ───────────────────────────────────────────────────────────── */
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px 24px; margin: 0 0 24px; }
.facts dt { font-size: 13px; color: var(--muted-foreground); }
.facts dd { margin: 2px 0 0; font-weight: 500; overflow-wrap: anywhere; }
.detail { font-size: 13px; color: var(--muted-foreground); overflow-wrap: anywhere; }

/* Response-time chart (shadcn area-chart conventions, status colours) */
.chart-stats { margin: -6px 0 20px; font-size: 13px; color: var(--muted-foreground); }
.chart { position: relative; height: 180px; margin-left: 52px; }
.chart.chart-strip { height: 32px; margin-left: 0; }
.chart svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.chart-line { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
.chart-line.ok { stroke: var(--success); } .chart-line.fail { stroke: var(--destructive); }
.chart-grid { position: absolute; left: 0; right: 0; border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent); }
.chart-grid > span { position: absolute; right: calc(100% + 12px); transform: translateY(-50%); font-size: 12px; color: var(--muted-foreground);
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.chart-col { position: absolute; top: 0; bottom: 0; outline: none; }
.chart-col::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px solid var(--border); opacity: 0; }
.chart-col:hover::before, .chart-col:focus::before { opacity: 1; }
.chart-dot { position: absolute; left: 50%; width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%);
  background: var(--success); box-shadow: 0 0 0 2px var(--card); opacity: 0; z-index: 1; }
.chart-col.fail .chart-dot { background: var(--destructive); }
.chart-col:hover .chart-dot, .chart-col:focus .chart-dot { opacity: 1; }
.chart-strip .chart-mark { position: absolute; inset: 4px 1px; border-radius: 2px; background: var(--success); }
.chart-strip .chart-col.fail .chart-mark { background: var(--destructive); }
/* shadcn ChartTooltip: inside the plot, beside the crosshair */
.chart-tip { display: none; position: absolute; z-index: 5; top: 8px; left: calc(50% + 12px); min-width: 168px; padding: 6px 10px;
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); background: var(--background); color: var(--foreground);
  font-size: 12px; line-height: 1.5; white-space: nowrap; box-shadow: 0 20px 25px -5px rgb(0 0 0 / .1), 0 8px 10px -6px rgb(0 0 0 / .1); }
.chart-tip.flip { left: auto; right: calc(50% + 12px); }
.chart-col:hover > .chart-tip, .chart-col:focus > .chart-tip { display: grid; gap: 4px; }
.tip-label { font-weight: 500; }
.tip-row { display: flex; align-items: center; gap: 8px; }
.tip-row i { width: 10px; height: 10px; border-radius: 2px; background: var(--success); flex: none; }
.tip-row i.fail { background: var(--destructive); }
.tip-row b { margin-left: auto; padding-left: 12px; font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.tip-err { color: var(--muted-foreground); white-space: normal; max-width: 220px; }
.chart-x { display: flex; justify-content: space-between; margin: 10px 0 0 52px; font-size: 12px; color: var(--muted-foreground); }
.chart-strip + .chart-x { margin-left: 0; }

/* shadcn Table */
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { height: 40px; padding: 0 16px 0 0; text-align: left; font-weight: 500; color: var(--muted-foreground); white-space: nowrap; }
th, td { border-bottom: 1px solid var(--border); vertical-align: middle; }
td { height: 44px; padding: 6px 16px 6px 0; overflow-wrap: anywhere; }
th:last-child, td:last-child { padding-right: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td .pill { vertical-align: middle; }
td.num .pill:not(:last-child) { margin-right: 8px; }
tbody tr:hover { background: color-mix(in oklab, var(--muted) 50%, transparent); }
tbody tr:last-child td { border-bottom: 0; }
/* Run history table: caret at the left of each row; details (run time, exit code, log) unfold below. */
.runs tr.has-detail { cursor: pointer; }
.run summary { display: inline-flex; align-items: center; gap: 10px; list-style: none; cursor: pointer; outline: none; }
.run summary::-webkit-details-marker { display: none; }
.run summary::before { content: ""; flex: none; width: 6px; height: 6px; margin: 0 2px; border-right: 1.5px solid var(--muted-foreground);
  border-bottom: 1.5px solid var(--muted-foreground); transform: rotate(-45deg); transition: transform .15s; }
.run[open] summary::before { transform: rotate(45deg); }
.run summary:focus-visible { border-radius: 4px; box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent); }
.run-static { padding-left: 20px; }
.detail-row { display: none; }
tr.has-detail:has(details[open]) + .detail-row { display: table-row; }
tr.has-detail:has(details[open]) td { border-bottom-color: transparent; }
tbody tr.detail-row:hover { background: none; }
.runs th:first-child, .runs td:first-child { width: 100%; }
.detail-row td { height: auto; padding: 0 0 14px; }
.run-detail { margin-left: 20px; padding: 2px 0 4px; }
.run-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px 24px; margin: 0; }
.run-facts dt { font-size: 12px; color: var(--muted-foreground); }
.run-facts dd { margin: 2px 0 0; font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.run-log { margin-top: 14px; }
.run-log-label { margin-bottom: 6px; font-size: 12px; color: var(--muted-foreground); }
.run-log pre { margin: 0; }
pre { margin: 8px 0 0; padding: 12px; max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  border-radius: calc(var(--radius) - 2px); background: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ── Sign-in (shadcn Card + Input) ──────────────────────────────────────────── */
.auth { max-width: 384px; margin: 32px auto 0; }
.auth-card { padding: 24px; }
.auth-card h1 { margin: 0 0 24px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.auth-form { display: grid; gap: 16px; }
.auth-form label { display: grid; gap: 8px; font-size: 14px; font-weight: 500; }
.auth-form input { height: 36px; padding: 4px 12px; border: 1px solid var(--input); border-radius: calc(var(--radius) - 2px);
  background: transparent; color: var(--foreground); font: inherit; font-size: 14px; outline: none;
  box-shadow: 0 1px 2px rgb(0 0 0 / .05); transition: box-shadow .15s, border-color .15s; }
.auth-form input:focus-visible { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent); }
.auth-form .btn-primary { width: 100%; margin-top: 8px; }
.form-error { margin: 0 0 16px; padding: 8px 12px; border: 1px solid color-mix(in oklab, var(--destructive) 40%, var(--border));
  border-radius: calc(var(--radius) - 2px); color: var(--destructive); font-size: 14px; }

/* ── Footer ─────────────────────────────────────────────────────────────────── */
.foot { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 8px; padding-bottom: 40px;
  text-align: center; font-size: 13px; color: var(--muted-foreground); }
.foot a { color: var(--foreground); }
.foot-info p { margin: 0 0 2px; }
`
