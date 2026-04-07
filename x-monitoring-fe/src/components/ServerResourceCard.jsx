import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import apiClient from "../services/http.js";
import "./ApiCard.css";
import "./ServerResourceCard.css";

/* ── helpers ─────────────────────────────────────────────────────── */

const MAX_SERVERS = 50;

const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
};

const generateId = () =>
    `srv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const incrementLabel = (label) => {
    const m = label.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (parseInt(m[2], 10) + 1);
    return label ? `${label}-2` : "";
};

const OS_OPTIONS = [
    { value: "windows", label: "Windows (WMI)" },
    { value: "windows-ssh", label: "Windows (PowerShell)" },
    { value: "linux-ubuntu24", label: "Linux (Ubuntu 24.04)" },
    { value: "linux-rhel8", label: "Linux (RHEL 8.x)" },
    { value: "linux-rhel7", label: "Linux (RHEL 7.x)" },
    { value: "linux-generic", label: "Linux (Generic)" },
];

const DEFAULT_CRITERIA = { cpu: 90, memory: 85, disk: 90 };

/** Migrate old single-server config → new multi-server format */
const migrateServers = (cfg) => {
    if (!cfg) return [];
    if (Array.isArray(cfg.servers)) return cfg.servers;
    if (cfg.osType) {
        return [{
            id: generateId(),
            label: cfg.host || "Server",
            osType: cfg.osType,
            host: cfg.host || "localhost",
            username: cfg.username || "",
            password: cfg.password || "",
            port: cfg.port || "",
            criteria: { ...DEFAULT_CRITERIA },
        }];
    }
    return [];
};

const formatInterval = (sec) => {
    if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
    if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
    return `every ${sec}s`;
};

const formatTime = (d) =>
    d ? d.toLocaleTimeString("en-GB", { hour12: false }) : null;

const worstPct = (d) => {
    if (!d) return null;
    return Math.max(
        d.cpu?.usedPct ?? 0,
        d.memory?.usedPct ?? 0,
        ...(d.disks || []).map((dk) => dk.usedPct ?? 0),
    );
};

/** Color by percentage — never red; red only comes from criteria alerts */
const pctColor = (pct) =>
    pct == null ? "#6b7280" : pct >= 70 ? "#f59e0b" : "#22c55e";

/** Check if any metric exceeds its threshold for a server */
const checkCriteria = (data, criteria) => {
    if (!data || !criteria) return [];
    const violations = [];
    if (criteria.cpu != null && data.cpu?.usedPct != null && data.cpu.usedPct >= criteria.cpu) {
        violations.push({ type: "CPU", value: data.cpu.usedPct, threshold: criteria.cpu });
    }
    if (criteria.memory != null && data.memory?.usedPct != null && data.memory.usedPct >= criteria.memory) {
        violations.push({ type: "MEM", value: data.memory.usedPct, threshold: criteria.memory });
    }
    if (criteria.disk != null) {
        (data.disks || []).forEach((dk) => {
            if (dk.usedPct != null && dk.usedPct >= criteria.disk) {
                violations.push({ type: `DSK${dk.mount ? ` ${dk.mount}` : ""}`, value: dk.usedPct, threshold: criteria.disk });
            }
        });
    }
    return violations;
};

const MAX_HISTORY = 120;

const DETAIL_COLORS = {
    cpu: "#19a0ff",
    memory: "#a29bfe",
    disk: ["#00cdb0", "#ffd166", "#ff8ea0", "#fdcb6e", "#55efc4", "#e17055"],
};

const formatChartTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
};

const DetailTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="srv-detail-tooltip">
            <div className="srv-detail-tooltip-time">{formatChartTime(label)}</div>
            {payload.map((p) => (
                <div key={p.dataKey} className="srv-detail-tooltip-row">
                    <span className="srv-detail-tooltip-dot" style={{ backgroundColor: p.color }} />
                    <span className="srv-detail-tooltip-name">{p.name}</span>
                    <span className="srv-detail-tooltip-val">{p.value != null ? `${p.value}%` : "-"}</span>
                </div>
            ))}
        </div>
    );
};

/* ── ServerDetailPopup — real-time chart modal ──────────────────── */

const ServerDetailPopup = ({ server, history, onClose }) => {
    if (!server || !history) return null;

    const data = history;
    const latestData = data.length > 0 ? data[data.length - 1] : null;

    // Collect all disk keys from history
    const diskKeys = useMemo(() => {
        const keys = new Set();
        data.forEach((pt) => {
            Object.keys(pt).forEach((k) => {
                if (k.startsWith("disk_")) keys.add(k);
            });
        });
        return [...keys].sort();
    }, [data]);

    const diskLabels = useMemo(() => {
        const map = {};
        diskKeys.forEach((k) => {
            map[k] = k.replace("disk_", "").toUpperCase();
        });
        return map;
    }, [diskKeys]);

    return createPortal(
        <div className="row-detail-overlay" onClick={onClose}>
            <div className="srv-detail-popup" onClick={(e) => e.stopPropagation()}>
                <div className="row-detail-header">
                    <div>
                        <h5>{server.label || server.host}</h5>
                        <p>{server.host}{server.port ? `:${server.port}` : ""}</p>
                    </div>
                    <button type="button" className="close-settings-btn" onClick={onClose}>✕</button>
                </div>

                <div className="srv-detail-body">
                    {/* CPU chart */}
                    <div className="srv-detail-chart-section">
                        <div className="srv-detail-chart-header">
                            <span className="srv-detail-chart-title" style={{ color: DETAIL_COLORS.cpu }}>CPU</span>
                            {latestData?.cpu != null && (
                                <span className="srv-detail-chart-current" style={{ color: DETAIL_COLORS.cpu }}>{latestData.cpu}%</span>
                            )}
                        </div>
                        <div className="srv-detail-chart-wrap">
                            <ResponsiveContainer width="100%" height={120}>
                                <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                                    <defs>
                                        <linearGradient id="grad-cpu" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor={DETAIL_COLORS.cpu} stopOpacity={0.3} />
                                            <stop offset="95%" stopColor={DETAIL_COLORS.cpu} stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                                    <XAxis dataKey="ts" tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                    <Tooltip content={<DetailTooltip />} />
                                    <Area type="monotone" dataKey="cpu" name="CPU" stroke={DETAIL_COLORS.cpu} fill="url(#grad-cpu)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Memory chart */}
                    <div className="srv-detail-chart-section">
                        <div className="srv-detail-chart-header">
                            <span className="srv-detail-chart-title" style={{ color: DETAIL_COLORS.memory }}>MEMORY</span>
                            {latestData?.memory != null && (
                                <span className="srv-detail-chart-current" style={{ color: DETAIL_COLORS.memory }}>{latestData.memory}%</span>
                            )}
                        </div>
                        <div className="srv-detail-chart-wrap">
                            <ResponsiveContainer width="100%" height={120}>
                                <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                                    <defs>
                                        <linearGradient id="grad-mem" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor={DETAIL_COLORS.memory} stopOpacity={0.3} />
                                            <stop offset="95%" stopColor={DETAIL_COLORS.memory} stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                                    <XAxis dataKey="ts" tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                    <Tooltip content={<DetailTooltip />} />
                                    <Area type="monotone" dataKey="memory" name="MEM" stroke={DETAIL_COLORS.memory} fill="url(#grad-mem)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Disk chart(s) */}
                    {diskKeys.length > 0 && (
                        <div className="srv-detail-chart-section">
                            <div className="srv-detail-chart-header">
                                <span className="srv-detail-chart-title" style={{ color: DETAIL_COLORS.disk[0] }}>DISK</span>
                                {diskKeys.length === 1 && latestData?.[diskKeys[0]] != null && (
                                    <span className="srv-detail-chart-current" style={{ color: DETAIL_COLORS.disk[0] }}>
                                        {diskLabels[diskKeys[0]]}: {latestData[diskKeys[0]]}%
                                    </span>
                                )}
                                {diskKeys.length > 1 && (
                                    <span className="srv-detail-chart-current-multi">
                                        {diskKeys.map((k, i) => (
                                            <span key={k} style={{ color: DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length] }}>
                                                {diskLabels[k]}: {latestData?.[k] ?? "-"}%
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </div>
                            <div className="srv-detail-chart-wrap">
                                <ResponsiveContainer width="100%" height={diskKeys.length > 1 ? 150 : 120}>
                                    <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                                        <defs>
                                            {diskKeys.map((k, i) => (
                                                <linearGradient key={k} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]} stopOpacity={0.25} />
                                                    <stop offset="95%" stopColor={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]} stopOpacity={0} />
                                                </linearGradient>
                                            ))}
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                                        <XAxis dataKey="ts" tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                        <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                        <Tooltip content={<DetailTooltip />} />
                                        {diskKeys.map((k, i) => (
                                            <Area
                                                key={k}
                                                type="monotone"
                                                dataKey={k}
                                                name={diskLabels[k]}
                                                stroke={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]}
                                                fill={`url(#grad-${k})`}
                                                strokeWidth={1.5}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                        ))}
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}
                </div>

                <div className="row-detail-footer">
                    <span className="row-detail-live-indicator">
                        <span className="live-dot" />
                        실시간 반영 중
                    </span>
                    <span className="srv-detail-points">{data.length} / {MAX_HISTORY} points</span>
                </div>
            </div>
        </div>,
        document.body,
    );
};

/* ── ServerRow — single-line server display ──────────────────────── */

const InlineBar = ({ pct, alert }) => {
    const color = alert ? "#ef4444" : pctColor(pct);
    return (
        <div className="srv-inline-bar">
            <div className={`srv-inline-bar-track${alert ? " srv-alert" : ""}`}>
                <div className="srv-inline-bar-fill" style={{ width: `${pct ?? 0}%`, backgroundColor: color }} />
            </div>
            <span className={`srv-inline-bar-val${alert ? " srv-alert" : ""}`} style={{ color }}>{pct != null ? `${pct}%` : "-"}</span>
        </div>
    );
};

const ServerRow = ({ server, data, loading, error, displayMode, violations, diskCycleIdx, onDoubleClick }) => {
    const d = data;
    const hasAlert = violations && violations.length > 0;
    const worst = worstPct(d);
    const dotColor = hasAlert ? "#ef4444" : error && !d ? "#ef4444" : pctColor(worst);
    const compact = displayMode === "compact" || displayMode === "mini";
    const crit = server.criteria || {};

    // Pick which disk(s) to show; compact/normal show 1 (cycling), wide shows up to 3
    const disks = d?.disks || [];
    const diskSlice = (() => {
        if (disks.length === 0) return [];
        if (displayMode === "wide") return disks.slice(0, 3);
        // Show 1 disk, cycling through all drives each refresh
        const idx = (diskCycleIdx ?? 0) % disks.length;
        return [disks[idx]];
    })();

    const osLabel = OS_OPTIONS.find((o) => o.value === server.osType)?.label || server.osType;
    const tooltip = [
        `이름: ${server.label || "(없음)"}`,
        `OS: ${osLabel}`,
        `호스트: ${server.host || "-"}${server.port ? `:${server.port}` : ""}`,
        `임계값 — CPU: ${crit.cpu ?? "-"}% / MEM: ${crit.memory ?? "-"}% / DISK: ${crit.disk ?? "-"}%`,
        d?.cpu?.usedPct != null ? `현재 CPU: ${d.cpu.usedPct}%` : null,
        d?.memory?.usedPct != null ? `현재 MEM: ${d.memory.usedPct}%` : null,
        ...(disks.map((dk) => dk.usedPct != null ? `현재 DISK(${dk.mount || "?"}): ${dk.usedPct}%` : null)),
        hasAlert ? `⚠ Alert: ${violations.map((v) => `${v.type} ${v.value}% ≥ ${v.threshold}%`).join(", ")}` : null,
        error ? `오류: ${typeof error === "string" ? error : "Error"}` : null,
    ].filter(Boolean).join("\n");

    return (
        <div className={`srv-row mode-${displayMode}${hasAlert ? " srv-alert" : ""}`} onDoubleClick={onDoubleClick} title={tooltip}>
            <span className={`srv-row-dot${hasAlert ? " pulse" : ""}`} style={{ backgroundColor: dotColor }} />
            <span className="srv-row-label">
                {server.label || server.host}
            </span>
            {!compact && (
                <span className="srv-row-host">{server.host}{server.port ? `:${server.port}` : ""}</span>
            )}

            {loading && !d && <span className="srv-row-spinner" />}

            {error && !d ? (
                <span className="srv-row-error">{typeof error === "string" ? error : "Error"}</span>
            ) : d ? (
                <div className="srv-row-metrics">
                    <div className="srv-metric">
                        <span className="srv-metric-label">CPU</span>
                        <InlineBar pct={d.cpu?.usedPct} alert={crit.cpu != null && d.cpu?.usedPct >= crit.cpu} />
                    </div>
                    <div className="srv-metric">
                        <span className="srv-metric-label">MEM</span>
                        <InlineBar pct={d.memory?.usedPct} alert={crit.memory != null && d.memory?.usedPct >= crit.memory} />
                    </div>
                    {diskSlice.map((dk, i) => {
                        const mt = dk.mount || "";
                        const shortMount = mt.length > 2 ? mt.slice(0, 2) + "…" : mt;
                        return (
                            <div className="srv-metric" key={dk.mount || i}>
                                <span className="srv-metric-label" title={mt ? `DISK (${mt})` : "DISK"}>DISK{shortMount ? `(${shortMount})` : ""}</span>
                                <InlineBar pct={dk.usedPct} alert={crit.disk != null && dk.usedPct >= crit.disk} />
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
};

/* ── Settings: single server row (collapsible) ───────────────────── */

const ServerSettingRow = ({
    server,
    expanded,
    onToggle,
    onChange,
    onDuplicate,
    onRemove,
}) => {
    const update = (field, value) => onChange(server.id, field, value);
    const updateCriteria = (field, value) => {
        const v = value === "" ? null : Number(value);
        onChange(server.id, "criteria", { ...(server.criteria || DEFAULT_CRITERIA), [field]: v });
    };
    const isLinux = server.osType?.startsWith("linux");
    const isWindowsSsh = server.osType === "windows-ssh";
    const isWindows = server.osType === "windows";
    const isRemote = server.host && server.host !== "localhost" && server.host !== "127.0.0.1";
    const crit = server.criteria || DEFAULT_CRITERIA;
    const summary = `${server.label || "(이름없음)"} — ${server.host || "(호스트없음)"}${server.port ? `:${server.port}` : ""}`;

    return (
        <div className={`srv-setting-row${expanded ? " expanded" : ""}`}>
            <div className="srv-setting-summary" onClick={onToggle}>
                <span className="srv-setting-chevron">{expanded ? "▾" : "▸"}</span>
                <span className="srv-setting-summary-text">{summary}</span>
                <span className="srv-setting-os-badge">{OS_OPTIONS.find((o) => o.value === server.osType)?.label || server.osType}</span>
                <div className="srv-setting-actions">
                    <button type="button" className="srv-action-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="복제">⧉</button>
                    <button type="button" className="srv-action-btn danger" onClick={(e) => { e.stopPropagation(); onRemove(); }} title="삭제">✕</button>
                </div>
            </div>

            {expanded && (
                <div className="srv-setting-detail">
                    <div className="srv-setting-grid-2">
                        <label>
                            <span>서버 이름</span>
                            <input type="text" value={server.label} onChange={(e) => update("label", e.target.value)} placeholder="예: Web-01" />
                        </label>
                        <label>
                            <span>OS 타입</span>
                            <select value={server.osType} onChange={(e) => update("osType", e.target.value)}>
                                {OS_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className="srv-setting-grid-2">
                        <label>
                            <span>호스트</span>
                            <input type="text" value={server.host} onChange={(e) => update("host", e.target.value)} placeholder="192.168.0.1" />
                        </label>
                        <label>
                            <span>{(isLinux || isWindowsSsh) ? "SSH 포트" : "포트"}</span>
                            <input type="number" value={server.port} onChange={(e) => update("port", e.target.value)} placeholder="22" />
                        </label>
                    </div>
                    {(isLinux || isWindowsSsh) && (
                        <div className="srv-setting-grid-2">
                            <label>
                                <span>SSH 사용자</span>
                                <input type="text" value={server.username} onChange={(e) => update("username", e.target.value)} />
                            </label>
                            <label>
                                <span>SSH 비밀번호</span>
                                <input type="password" value={server.password} onChange={(e) => update("password", e.target.value)} />
                            </label>
                        </div>
                    )}
                    {isWindows && isRemote && (
                        <div className="srv-setting-grid-3">
                            <label>
                                <span>사용자명</span>
                                <input type="text" value={server.username || ""} onChange={(e) => update("username", e.target.value)} placeholder="Administrator" />
                            </label>
                            <label>
                                <span>비밀번호</span>
                                <input type="password" value={server.password || ""} onChange={(e) => update("password", e.target.value)} />
                            </label>
                            <label>
                                <span>도메인 (선택)</span>
                                <input type="text" value={server.domain || ""} onChange={(e) => update("domain", e.target.value)} placeholder="MYDOMAIN" />
                            </label>
                        </div>
                    )}
                    {/* ── Alert Criteria ─────────── */}
                    <div className="srv-criteria-section">
                        <span className="srv-criteria-title">Alert 임계값 (%)</span>
                        <div className="srv-setting-grid-3">
                            <label>
                                <span>CPU</span>
                                <input type="number" value={crit.cpu ?? ""} onChange={(e) => updateCriteria("cpu", e.target.value)} placeholder="90" min="0" max="100" />
                            </label>
                            <label>
                                <span>Memory</span>
                                <input type="number" value={crit.memory ?? ""} onChange={(e) => updateCriteria("memory", e.target.value)} placeholder="85" min="0" max="100" />
                            </label>
                            <label>
                                <span>Disk</span>
                                <input type="number" value={crit.disk ?? ""} onChange={(e) => updateCriteria("disk", e.target.value)} placeholder="90" min="0" max="100" />
                            </label>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

/* ══════════════════════════════════════════════════════════════════
   Main component
   ══════════════════════════════════════════════════════════════════ */

const ServerResourceCard = ({
    title,
    widgetConfig,
    onRemove,
    onRefresh,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onWidgetConfigChange,
    onAlarmChange,
}) => {
    /* ── derived: servers list (migrate old format) ──────────────── */
    const servers = useMemo(() => migrateServers(widgetConfig), [widgetConfig]);

    /* ── display mode based on grid width ────────────────────────── */
    const widgetW = currentSize?.w ?? 4;
    const displayMode = widgetW <= 2 ? "mini" : widgetW <= 3 ? "compact" : widgetW <= 6 ? "normal" : "wide";

    /* ── per-server data map ─────────────────────────────────────── */
    const [serverStates, setServerStates] = useState({});
    const [diskCycleIdx, setDiskCycleIdx] = useState(0);
    const serversRef = useRef(servers);
    const timerRef = useRef(null);

    /* ── history for detail popup charts ────────────────────────── */
    const historyRef = useRef({});
    const [historyVersion, setHistoryVersion] = useState(0);
    const [detailServerId, setDetailServerId] = useState(null);

    useEffect(() => { serversRef.current = servers; }, [servers]);

    // 서버 목록이 변하면 historyRef에서 사라진 서버의 히스토리 키를 정리한다.
    // (각 키는 MAX_HISTORY로 cap되지만, 잦은 추가/삭제 시 유령 키가 누적될 수 있음)
    useEffect(() => {
        const liveIds = new Set(servers.map((s) => s.id));
        let purged = false;
        Object.keys(historyRef.current).forEach((id) => {
            if (!liveIds.has(id)) {
                delete historyRef.current[id];
                purged = true;
            }
        });
        if (purged) setHistoryVersion((v) => v + 1);
    }, [servers]);

    const fetchAllServers = useCallback(async () => {
        const list = serversRef.current;
        if (list.length === 0) return;
        setDiskCycleIdx((prev) => prev + 1);

        const batchPayload = list.map((srv) => {
            const item = { os_type: srv.osType, host: srv.host || "localhost" };
            if (srv.osType === "windows" && srv.host !== "localhost" && srv.host !== "127.0.0.1") {
                if (srv.username) item.username = srv.username;
                if (srv.password) item.password = srv.password;
                if (srv.domain) item.domain = srv.domain;
            }
            if ((srv.osType.startsWith("linux") || srv.osType === "windows-ssh") && srv.host !== "localhost" && srv.host !== "127.0.0.1") {
                item.username = srv.username;
                item.password = srv.password;
                if (srv.port) item.port = Number(srv.port);
            }
            return item;
        });

        try {
            const res = await apiClient.post("/dashboard/server-resources-batch", { servers: batchPayload });
            const batchResults = res.data?.results || [];

            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv, i) => {
                    const data = batchResults[i] || null;
                    if (data) {
                        next[srv.id] = { data, error: data.error || null, loading: false, lastUpdated: new Date() };
                    } else {
                        next[srv.id] = {
                            data: next[srv.id]?.data ?? null,
                            error: "No result from batch",
                            loading: false,
                            lastUpdated: next[srv.id]?.lastUpdated ?? null,
                        };
                    }
                });
                return next;
            });
        } catch (err) {
            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv) => {
                    next[srv.id] = {
                        data: next[srv.id]?.data ?? null,
                        error: err?.response?.data?.message || err?.message || "요청 실패",
                        loading: false,
                        lastUpdated: next[srv.id]?.lastUpdated ?? null,
                    };
                });
                return next;
            });
        }
    }, []);

    // stable key for detecting server list changes
    const serversKey = useMemo(
        () => servers.map((s) => `${s.id}|${s.host}|${s.osType}`).join(","),
        [servers],
    );

    useEffect(() => {
        if (servers.length > 0) fetchAllServers();
    }, [serversKey, fetchAllServers]);

    useEffect(() => {
        if (servers.length === 0) return;
        const ms = (refreshIntervalSec ?? 30) * 1000;
        timerRef.current = setInterval(fetchAllServers, ms);
        return () => clearInterval(timerRef.current);
    }, [serversKey, refreshIntervalSec, fetchAllServers]);

    /* ── accumulate history for charts ─────────────────────────── */
    useEffect(() => {
        const now = Date.now();
        let changed = false;
        Object.entries(serverStates).forEach(([id, state]) => {
            if (!state?.data) return;
            const d = state.data;
            const point = { ts: now, cpu: d.cpu?.usedPct ?? null, memory: d.memory?.usedPct ?? null };
            (d.disks || []).forEach((dk) => {
                const key = `disk_${(dk.mount || "root").toLowerCase()}`;
                point[key] = dk.usedPct ?? null;
            });
            const prev = historyRef.current[id] || [];
            // Avoid duplicates for same timestamp (within 500ms)
            if (prev.length > 0 && Math.abs(prev[prev.length - 1].ts - now) < 500) return;
            // Always create a new array (React dev mode may freeze arrays passed as props)
            const next = [...prev, point];
            historyRef.current[id] = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
            changed = true;
        });
        if (changed) setHistoryVersion((v) => v + 1);
    }, [serverStates]);

    const detailServer = useMemo(
        () => (detailServerId ? servers.find((s) => s.id === detailServerId) : null),
        [detailServerId, servers],
    );

    const detailHistory = useMemo(
        () => (detailServerId ? (historyRef.current[detailServerId] || []) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [detailServerId, historyVersion],
    );

    /* ── per-server violations (criteria check) ─────────────────── */
    const violationsMap = useMemo(() => {
        const map = {};
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            if (state?.data) {
                map[srv.id] = checkCriteria(state.data, srv.criteria || DEFAULT_CRITERIA);
            }
        });
        return map;
    }, [servers, serverStates]);

    const totalViolations = useMemo(
        () => Object.values(violationsMap).reduce((sum, v) => sum + v.length, 0),
        [violationsMap],
    );

    const statusCounts = useMemo(() => {
        let ok = 0, ng = 0;
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            const v = violationsMap[srv.id] || [];
            if (!state?.data && state?.error) ng++;
            else if (v.length > 0) ng++;
            else if (state?.data) ok++;
        });
        return { ok, ng };
    }, [servers, serverStates, violationsMap]);

    // Detect backend-level failure (all servers unreachable)
    const isDead = useMemo(() => {
        if (servers.length === 0) return false;
        return servers.every((srv) => {
            const st = serverStates[srv.id];
            return st?.error && !st?.data;
        });
    }, [servers, serverStates]);

    // Report alarm status to parent
    useEffect(() => {
        if (!onAlarmChange) return;
        onAlarmChange(totalViolations > 0 || isDead ? "dead" : "live");
    }, [totalViolations, isDead, onAlarmChange]);

    /* ── settings modal state ────────────────────────────────────── */
    const [showSettings, setShowSettings] = useState(false);
    const hasAutoOpened = useRef(false);

    useEffect(() => {
        if (!hasAutoOpened.current && servers.length === 0) {
            setShowSettings(true);
            hasAutoOpened.current = true;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* ── settings draft state ────────────────────────────────────── */
    const [sizeDraft, setSizeDraft] = useState({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 5 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 30);
    const [titleDraft, setTitleDraft] = useState(title);
    const [serversDraft, setServersDraft] = useState([]);
    const [expandedId, setExpandedId] = useState(null);

    useEffect(() => { setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 5 }); }, [currentSize?.w, currentSize?.h]);
    useEffect(() => { setIntervalDraft(refreshIntervalSec ?? 30); }, [refreshIntervalSec]);
    useEffect(() => { setTitleDraft(title); }, [title]);

    const openSettings = useCallback(() => {
        setServersDraft(servers.map((s) => ({ ...s, criteria: { ...DEFAULT_CRITERIA, ...s.criteria } })));
        setExpandedId(null);
        setShowSettings(true);
    }, [servers]);

    /* ── settings handlers ───────────────────────────────────────── */
    const handleSizeApply = () => {
        const w = clamp(sizeDraft.w, sizeBounds?.minW ?? 2, sizeBounds?.maxW ?? 12, currentSize?.w ?? 4);
        const h = clamp(sizeDraft.h, sizeBounds?.minH ?? 2, sizeBounds?.maxH ?? 24, currentSize?.h ?? 5);
        setSizeDraft({ w, h });
        onSizeChange(w, h);
    };

    const handleIntervalApply = () => {
        const v = clamp(intervalDraft, 5, 3600, 30);
        setIntervalDraft(v);
        onRefreshIntervalChange(v);
    };

    const handleTitleApply = () => {
        const t = titleDraft.trim();
        if (t && t !== title) onWidgetMetaChange?.({ title: t });
    };

    const handleAddServer = () => {
        if (serversDraft.length >= MAX_SERVERS) {
            window.alert(`최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`);
            return;
        }
        const last = serversDraft[serversDraft.length - 1];
        const newSrv = {
            id: generateId(),
            label: "",
            osType: last?.osType || "linux-rhel8",
            host: "",
            username: last?.username || "",
            password: last?.password || "",
            domain: last?.domain || "",
            port: last?.port || "22",
            criteria: { ...DEFAULT_CRITERIA },
        };
        setServersDraft((p) => [...p, newSrv]);
        setExpandedId(newSrv.id);
    };

    const handleDuplicateServer = (srv) => {
        if (serversDraft.length >= MAX_SERVERS) {
            window.alert(`최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`);
            return;
        }
        const dup = { ...srv, id: generateId(), label: incrementLabel(srv.label), criteria: { ...srv.criteria }, domain: srv.domain || "" };
        setServersDraft((p) => [...p, dup]);
        setExpandedId(dup.id);
    };

    const handleRemoveServer = (id) => {
        setServersDraft((p) => p.filter((s) => s.id !== id));
        if (expandedId === id) setExpandedId(null);
    };

    const handleUpdateServerField = (id, field, value) => {
        setServersDraft((p) => p.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
    };

    const handleSaveServers = () => {
        onWidgetConfigChange?.({ servers: serversDraft });
        setShowSettings(false);
    };

    /* ── summary info ────────────────────────────────────────────── */
    const lastUpdated = useMemo(() => {
        let latest = null;
        Object.values(serverStates).forEach((s) => {
            if (s.lastUpdated && (!latest || s.lastUpdated > latest)) latest = s.lastUpdated;
        });
        return latest;
    }, [serverStates]);

    /* ── render: settings popup ──────────────────────────────────── */
    // 외부 클릭으로는 닫히지 않는다 — 헤더의 ✕ 버튼으로만 닫힌다.
    // (사용자 요구: 바깥쪽 오클릭으로 설정 변경이 날아가는 것을 방지)
    const settingsPopup = showSettings ? (
        <div
            className="settings-overlay"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            <div
                className="settings-popup srv-settings-popup"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="settings-popup-header">
                    <div>
                        <h5>서버 리소스 위젯 설정</h5>
                        <p>{title}</p>
                    </div>
                    <button type="button" className="close-settings-btn" onClick={() => setShowSettings(false)}>✕</button>
                </div>
                <div className="settings-popup-body">
                    <div className="settings-section">
                        <h6>위젯 정보</h6>
                        <div className="size-editor widget-meta-editor">
                            <label>
                                Title
                                <input type="text" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
                            </label>
                            <button type="button" className="size-preset-btn" onClick={handleTitleApply}>적용</button>
                        </div>
                    </div>
                    <div className="settings-inline-row">
                        <div className="settings-section">
                            <h6>위젯 크기</h6>
                            <div className="size-editor widget-size-editor">
                                <label>Width<input type="number" min={sizeBounds?.minW ?? 2} max={sizeBounds?.maxW ?? 12} value={sizeDraft.w} onChange={(e) => setSizeDraft((p) => ({ ...p, w: e.target.value }))} /></label>
                                <label>Height<input type="number" min={sizeBounds?.minH ?? 2} max={sizeBounds?.maxH ?? 24} value={sizeDraft.h} onChange={(e) => setSizeDraft((p) => ({ ...p, h: e.target.value }))} /></label>
                                <button type="button" className="size-preset-btn" onClick={handleSizeApply}>적용</button>
                            </div>
                        </div>
                        <div className="settings-section refresh-interval-section">
                            <h6>갱신 주기 (초)</h6>
                            <div className="refresh-interval-editor">
                                <label className="refresh-interval-input-label"><span>Interval</span><input type="number" min="5" max="3600" value={intervalDraft} onChange={(e) => setIntervalDraft(e.target.value)} /></label>
                                <button type="button" className="size-preset-btn" onClick={handleIntervalApply}>적용</button>
                            </div>
                        </div>
                    </div>
                    <div className="settings-section srv-list-section">
                        <div className="srv-list-header">
                            <h6>서버 목록 ({serversDraft.length} / {MAX_SERVERS})</h6>
                            <button type="button" className="size-preset-btn srv-add-btn" onClick={handleAddServer} disabled={serversDraft.length >= MAX_SERVERS}>＋ 서버 추가</button>
                        </div>
                        {serversDraft.length === 0 ? (
                            <div className="srv-list-empty">
                                <p>등록된 서버가 없습니다.</p>
                                <button type="button" className="size-preset-btn" onClick={handleAddServer}>첫 서버 추가</button>
                            </div>
                        ) : (
                            <div className="srv-list-items">
                                {serversDraft.map((srv) => (
                                    <ServerSettingRow
                                        key={srv.id}
                                        server={srv}
                                        expanded={expandedId === srv.id}
                                        onToggle={() => setExpandedId(expandedId === srv.id ? null : srv.id)}
                                        onChange={handleUpdateServerField}
                                        onDuplicate={() => handleDuplicateServer(srv)}
                                        onRemove={() => handleRemoveServer(srv.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
                <div className="srv-settings-footer">
                    <button type="button" className="size-preset-btn" onClick={() => setShowSettings(false)}>취소</button>
                    <button type="button" className="size-preset-btn srv-save-btn" onClick={handleSaveServers}>
                        서버 목록 저장 ({serversDraft.length}개)
                    </button>
                </div>
            </div>
        </div>
    ) : null;

    /* ── render: main card ───────────────────────────────────────── */
    return (
        <div className="api-card">
            <div className="api-card-header">
                <div className="api-card-title-section">
                    <div className="api-card-title-row">
                        <h4 title={title}>{title}</h4>
                        {isDead && (
                            <span className="status-pill dead">
                                <span className="status-dot" />
                                DEAD
                            </span>
                        )}
                        <div className="title-actions">
                            <button type="button" className="compact-icon-btn" onClick={fetchAllServers} title="새로고침">⟳</button>
                            <button type="button" className="compact-icon-btn" onClick={openSettings} title="설정">⚙</button>
                            <button type="button" className="compact-icon-btn remove" onClick={onRemove} title="제거">✕</button>
                        </div>
                    </div>
                    <div className="api-endpoint-row">
                        <div className="api-endpoint-info">
                            {servers.length === 0 ? (
                                <span className="api-endpoint">서버 미설정</span>
                            ) : (
                                <>
                                    {statusCounts.ok > 0 && <span className="status-badge ok">{statusCounts.ok} OK</span>}
                                    {statusCounts.ng > 0 && <span className="status-badge ng">{statusCounts.ng} NG</span>}
                                    {statusCounts.ok === 0 && statusCounts.ng === 0 && <span className="api-endpoint">{servers.length}개 서버</span>}
                                </>
                            )}
                        </div>
                        <span className="refresh-interval-chip">⏱ {formatInterval(refreshIntervalSec ?? 30)}</span>
                        {lastUpdated && <span className="last-updated-time">{formatTime(lastUpdated)}</span>}
                    </div>
                </div>
            </div>

            {settingsPopup && createPortal(settingsPopup, document.body)}
            {detailServer && (
                <ServerDetailPopup
                    server={detailServer}
                    history={detailHistory}
                    onClose={() => setDetailServerId(null)}
                />
            )}

            <div className="api-card-content">
                {servers.length === 0 ? (
                    <div className="resource-setup-prompt">
                        <p>서버 접속 정보를 설정해주세요.</p>
                        <button type="button" className="size-preset-btn" onClick={openSettings}>설정 열기</button>
                    </div>
                ) : (
                    <div className={`srv-list srv-list-${displayMode}`}>
                        {servers.map((srv) => (
                            <ServerRow
                                key={srv.id}
                                server={srv}
                                data={serverStates[srv.id]?.data}
                                loading={serverStates[srv.id]?.loading !== false && !serverStates[srv.id]?.data}
                                error={serverStates[srv.id]?.error}
                                displayMode={displayMode}
                                violations={violationsMap[srv.id]}
                                diskCycleIdx={diskCycleIdx}
                                onDoubleClick={() => setDetailServerId(srv.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ServerResourceCard;
