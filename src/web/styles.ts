import { UI_STYLES } from '@statusping/ui/styles'

/**
 * Styles follow shadcn/ui's default "neutral" theme (https://ui.shadcn.com/docs/theming):
 * the same CSS variables, radius scale and component conventions (Card, Alert, Badge, Button,
 * Input, Table, DropdownMenu, Popover). Status colours are the only accents.
 */
const APP_STYLES = `
/* ── Header bar ─────────────────────────────────────────────────────────────── */
.site-header { position: sticky; top: 0; z-index: 30; border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--background) 85%, transparent); backdrop-filter: blur(8px); }
.site-header-inner { display: flex; align-items: center; gap: 12px; height: 56px; }
.account { margin-left: auto; display: flex; align-items: center; gap: 12px; }
/* Ghost button (shadcn variant="ghost"), the same height as the Sign out button beside it. */
.header-link { display: inline-flex; align-items: center; height: 36px; padding: 0 12px; border-radius: calc(var(--radius) - 2px); font-size: 14px; font-weight: 500; color: var(--foreground); }
.header-link:hover { background: var(--accent); color: var(--accent-foreground); text-decoration: none; }
.header-link[aria-current="page"] { background: var(--muted); }
@media (max-width: 480px) { .account-email { display: none; } }

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

/* ── Status banner ──────────────────────────────────────────────────────────── */
.status { --tone: var(--success); margin-bottom: 24px; overflow: hidden; border: 1px solid color-mix(in oklab, var(--tone) 55%, var(--border));
  border-radius: var(--radius); background: var(--card); color: var(--card-foreground); }
.status.down { --tone: var(--destructive); } .status.late, .status.warning { --tone: var(--warning); }
.status-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: color-mix(in oklab, var(--tone) 18%, var(--card)); }
.status-head h2 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; color: var(--foreground); }
.status-icon { display: inline-flex; flex: none; color: var(--tone); --status-icon-fg: var(--card); }
.status-icon.down { color: var(--destructive); } .status-icon.late, .status-icon.warning { color: var(--warning); }
.status-body { margin: 0; padding: 14px 20px; font-size: 15px; }
.status .stale-warning { padding: 0 20px 14px; margin: 14px 0 0; }
.status-chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.chip { --chip: var(--destructive); display: inline-flex; align-items: center; padding: 3px 10px; border-radius: calc(var(--radius) - 4px);
  border: 1px solid color-mix(in oklab, var(--chip) 45%, transparent); background: color-mix(in oklab, var(--chip) 14%, transparent);
  color: color-mix(in oklab, var(--chip) 75%, var(--foreground)); font-size: 14px; font-weight: 500; }
.chip.late { --chip: var(--warning); }
.chip:hover { text-decoration: none; background: color-mix(in oklab, var(--chip) 22%, transparent); }
.pill.maintenance::before { background: var(--muted-foreground); }
.maintenance-banner { margin: 0 0 24px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
.maintenance-banner.active { border-color: color-mix(in oklab, var(--muted-foreground) 48%, var(--border)); }
.maintenance-heading { display: flex; align-items: center; gap: 10px; padding: 14px 20px; background: var(--muted); }
.maintenance-heading h2 { margin: 0; font-size: 16px; font-weight: 550; letter-spacing: -.01em; }
.maintenance-icon { color: var(--muted-foreground); font-size: 11px; }
.maintenance-note { margin-left: auto; color: var(--muted-foreground); font-size: 13px; }
.maintenance-list { display: grid; gap: 1px; background: var(--border); }
.maintenance-item { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; padding: 12px 20px; background: var(--card); font-size: 14px; }
.maintenance-monitors { display: block; margin-top: 2px; color: var(--muted-foreground); font-size: 13px; }
.maintenance-time { flex: none; color: var(--muted-foreground); font-size: 13px; text-align: right; }
.monitor-maintenance { margin-top: 24px; }
.status-incidents { display: grid; gap: 8px; padding: 8px; }
.incident { padding: 14px 16px; border-radius: calc(var(--radius) - 2px); background: var(--muted); }
.incident-title { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 15px; }
.incident-title .status-icon svg { width: 18px; height: 18px; }
.incident-title a { color: var(--foreground); }
.incident-body { margin: 6px 0 0 28px; font-size: 15px; line-height: 1.55; color: var(--foreground); overflow-wrap: anywhere; }
.incident-meta { display: flex; flex-wrap: wrap; gap: 0 8px; margin: 8px 0 0 28px; font-size: 14px; color: var(--muted-foreground); }
.stale-warning { font-size: 14px; color: var(--destructive); }
.warning-incidents { border-top: 1px solid color-mix(in oklab, var(--warning) 30%, var(--border)); }
.warning-incident { background: color-mix(in oklab, var(--warning) 8%, var(--muted)); }

.mons > li + li { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }
.mon-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.mon-name { font-weight: 500; color: var(--foreground); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted-foreground); }
.dot.up { background: var(--success); } .dot.down { background: var(--destructive); } .dot.late { background: var(--warning); }
.dot.maintenance { background: var(--muted-foreground); }
.pill.warning::before { background: var(--warning); }

/* Uptime bars */
.bars { display: flex; gap: 2px; height: 32px; }
.bar { flex: 1; min-width: 2px; border-radius: 2px; background: var(--nodata); position: relative; }
.bar.up { background: var(--success); } .bar.partial { background: var(--warning); } .bar.down { background: var(--destructive); }
.bar.maintenance::after { content: ''; position: absolute; inset: auto 0 0; height: 3px; border-radius: 0 0 2px 2px; background: var(--muted-foreground); opacity: .85; }
.bar[tabindex] { cursor: pointer; outline: none; }
.bar[tabindex]:hover, .bar[tabindex]:focus { box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--ring); }
.bar-legend { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
@media (max-width: 600px) { .bar:nth-child(-n+60) { display: none; } .bar-legend span:first-child { visibility: hidden; } }

/* Small, intentionally quiet rollup trend below the uptime history. */
.latency-trend { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: var(--muted-foreground); }
.latency-label { flex: none; font-size: 12px; white-space: nowrap; }
.latency-label span { color: var(--muted-foreground); opacity: .75; }
.latency-trend svg { height: 28px; flex: 1; min-width: 0; overflow: visible; }
.latency-trend path { fill: none; stroke: var(--success); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linecap: round; stroke-linejoin: round; }

.pop-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.pop-head strong { font-weight: 600; }
.pop-total { font-weight: 500; color: var(--destructive); white-space: nowrap; }
.pop-sub { display: block; margin-top: 2px; font-size: 12px; color: var(--muted-foreground); }
.pop-list { display: block; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.pop-item { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; padding: 4px 0; }
.pop-item + .pop-item { border-top: 1px solid var(--border); }
.pop-dur { grid-row: span 3; min-width: 44px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--warning); }
.pop-maintenance { display: block; margin-top: 5px; color: var(--muted-foreground); font-size: 12px; }
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
.warning-panel { border-color: color-mix(in oklab, var(--warning) 55%, var(--border)); background: color-mix(in oklab, var(--warning) 5%, var(--card)); }
.warning-panel h2 { display: flex; align-items: center; gap: 8px; }
.warning-panel h2 .status-icon svg { width: 18px; height: 18px; }
.warning-list { display: grid; gap: 8px; margin: 0; padding-left: 20px; }
.warning-list li { overflow-wrap: anywhere; }
.warning-meta { display: block; margin-top: 2px; font-size: 13px; color: var(--muted-foreground); }

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

/* ── Select (shadcn Select trigger): own chevron with the same inset as the text ── */
select.input { appearance: none; -webkit-appearance: none; padding-right: 36px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center; background-size: 16px 16px; }
select.input option { background: var(--popover); color: var(--popover-foreground); }

/* ── Sign-in (shadcn Card + Input) ──────────────────────────────────────────── */
.auth { max-width: 384px; margin: 32px auto 0; }
.auth-card { padding: 24px; }
.auth-card h1 { margin: 0 0 24px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.auth-form { display: grid; gap: 16px; }
.auth-form label { display: grid; gap: 8px; font-size: 14px; font-weight: 500; }
.auth-form .btn-primary, .auth-card .sso-button { width: 100%; margin-top: 8px; }
.auth-card p.muted { margin: -12px 0 16px; }
.form-error { margin: 0 0 16px; padding: 8px 12px; border: 1px solid color-mix(in oklab, var(--destructive) 40%, var(--border));
  border-radius: calc(var(--radius) - 2px); color: var(--destructive); font-size: 14px; }

/* ── Footer ─────────────────────────────────────────────────────────────────── */
.foot { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 8px; padding-bottom: 40px;
  text-align: center; font-size: 13px; color: var(--muted-foreground); }
.foot a { color: var(--foreground); }
.foot-info p { margin: 0 0 2px; }
`

export const STYLES = `${UI_STYLES}\n${APP_STYLES}`
