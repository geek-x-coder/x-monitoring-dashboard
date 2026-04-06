import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import "./LineChartCard.css";

const CHART_COLORS = [
    "#19a0ff",
    "#00cdb0",
    "#ff8ea0",
    "#ffd166",
    "#a29bfe",
    "#fd79a8",
    "#55efc4",
    "#fdcb6e",
    "#74b9ff",
    "#e17055",
];

const MAX_CHART_POINTS = 500;

const downsample = (rows, maxPoints) => {
    if (rows.length <= maxPoints) return rows;
    const step = rows.length / maxPoints;
    const result = [];
    for (let i = 0; i < maxPoints; i++) {
        result.push(rows[Math.round(i * step)]);
    }
    return result;
};

const TIME_RANGES = [
    { label: "전체", key: "all" },
    { label: "1h", key: "1h" },
    { label: "6h", key: "6h" },
    { label: "24h", key: "24h" },
    { label: "7d", key: "7d" },
];

const TIME_RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
};

const tryParseDate = (val) => {
    if (val == null || val === "") return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
};

const filterByTimeRange = (rows, xKey, rangeKey) => {
    if (rangeKey === "all" || !xKey || !rows.length) return rows;
    const rangeMs = TIME_RANGE_MS[rangeKey];
    if (!rangeMs) return rows;

    const sample = rows.slice(0, Math.min(10, rows.length));
    const parseableCount = sample.filter(
        (r) => tryParseDate(r[xKey]) !== null,
    ).length;

    if (parseableCount / Math.max(sample.length, 1) >= 0.5) {
        const cutoff = Date.now() - rangeMs;
        return rows.filter((r) => {
            const d = tryParseDate(r[xKey]);
            return d !== null && d.getTime() >= cutoff;
        });
    }

    const rowCounts = { "1h": 60, "6h": 360, "24h": 720, "7d": 2016 };
    const n = rowCounts[rangeKey] ?? rows.length;
    return rows.slice(-n);
};

const normalizeData = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") {
        return Object.entries(raw).map(([k, v]) => ({
            _key: k,
            ...(typeof v === "object" && v !== null ? v : { value: v }),
        }));
    }
    return [];
};

const detectColumns = (rows) => {
    const cols = new Set();
    rows.slice(0, 20).forEach((r) => {
        if (r && typeof r === "object") {
            Object.keys(r)
                .filter((k) => !k.startsWith("_"))
                .forEach((k) => cols.add(k));
        }
    });
    return Array.from(cols);
};

const ChartTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className='lc-tooltip'>
            <p className='lc-tooltip-label'>{String(label)}</p>
            {payload.map((entry) => (
                <div
                    key={entry.dataKey}
                    className='lc-tooltip-row'
                    style={{ color: entry.color }}
                >
                    <span className='lc-tooltip-name'>{entry.name}</span>
                    <span className='lc-tooltip-value'>
                        {typeof entry.value === "number"
                            ? entry.value.toLocaleString()
                            : String(entry.value ?? "—")}
                    </span>
                </div>
            ))}
        </div>
    );
};

const LineChartCard = ({
    title,
    endpoint,
    data,
    loading,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    currentSize,
    sizeBounds,
    onSizeChange,
    chartSettings,
    onChartSettingsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [timeRange, setTimeRange] = useState(
        chartSettings?.timeRange ?? "all",
    );
    const [xKeyDraft, setXKeyDraft] = useState(chartSettings?.xAxisKey ?? "");
    const [yKeysDraft, setYKeysDraft] = useState(
        chartSettings?.yAxisKeys ?? [],
    );
    const [showLegend, setShowLegend] = useState(
        chartSettings?.showLegend ?? true,
    );
    const [maxPointsDraft, setMaxPointsDraft] = useState(
        chartSettings?.maxPoints ?? MAX_CHART_POINTS,
    );
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });

    useEffect(() => setTitleDraft(title), [title]);
    useEffect(() => setEndpointDraft(endpoint), [endpoint]);
    useEffect(
        () => setIntervalDraft(refreshIntervalSec ?? 5),
        [refreshIntervalSec],
    );
    useEffect(
        () => setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 4 }),
        [currentSize?.w, currentSize?.h],
    );
    useEffect(() => {
        if (chartSettings?.timeRange) setTimeRange(chartSettings.timeRange);
    }, [chartSettings?.timeRange]);
    useEffect(() => {
        setShowLegend(chartSettings?.showLegend ?? true);
    }, [chartSettings?.showLegend]);
    useEffect(() => {
        setMaxPointsDraft(chartSettings?.maxPoints ?? MAX_CHART_POINTS);
    }, [chartSettings?.maxPoints]);

    const rows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => detectColumns(rows), [rows]);

    const xAxisKey =
        chartSettings?.xAxisKey ||
        (detectedColumns.length > 0 ? detectedColumns[0] : "");
    const yAxisKeys =
        chartSettings?.yAxisKeys?.length > 0
            ? chartSettings.yAxisKeys
            : detectedColumns.filter((c) => c !== xAxisKey).slice(0, 4);

    const filteredRows = useMemo(
        () => filterByTimeRange(rows, xAxisKey, timeRange),
        [rows, xAxisKey, timeRange],
    );

    const effectiveMaxPoints = chartSettings?.maxPoints ?? MAX_CHART_POINTS;
    const chartRows = useMemo(
        () => downsample(filteredRows, effectiveMaxPoints),
        [filteredRows, effectiveMaxPoints],
    );
    const isDownsampled = chartRows.length < filteredRows.length;

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const handleTimeRangeChange = (key) => {
        setTimeRange(key);
        onChartSettingsChange?.({ timeRange: key });
    };

    const handleApplySettings = () => {
        const resolvedX = xKeyDraft || xAxisKey;
        const resolvedY =
            yKeysDraft.length > 0
                ? yKeysDraft
                : detectedColumns.filter((c) => c !== resolvedX).slice(0, 4);

        const nextMaxPoints = Math.min(
            10000,
            Math.max(50, Number(maxPointsDraft) || MAX_CHART_POINTS),
        );
        setMaxPointsDraft(nextMaxPoints);

        onChartSettingsChange?.({
            xAxisKey: resolvedX,
            yAxisKeys: resolvedY,
            timeRange,
            showLegend,
            maxPoints: nextMaxPoints,
        });

        if (
            titleDraft.trim() &&
            endpointDraft.trim() &&
            (titleDraft.trim() !== title || endpointDraft.trim() !== endpoint)
        ) {
            onWidgetMetaChange?.({
                title: titleDraft.trim(),
                endpoint: endpointDraft.trim(),
            });
        }

        const nextInterval = Math.min(
            3600,
            Math.max(1, Number(intervalDraft) || 5),
        );
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange?.(nextInterval);

        const minW = sizeBounds?.minW ?? 2;
        const maxW = sizeBounds?.maxW ?? 12;
        const minH = sizeBounds?.minH ?? 2;
        const maxH = sizeBounds?.maxH ?? 24;
        const nw = Math.min(
            maxW,
            Math.max(minW, Math.floor(Number(sizeDraft.w) || minW)),
        );
        const nh = Math.min(
            maxH,
            Math.max(minH, Math.floor(Number(sizeDraft.h) || minH)),
        );
        setSizeDraft({ w: nw, h: nh });
        onSizeChange?.(nw, nh);

        setShowSettings(false);
    };

    const toggleYKey = (col) => {
        setYKeysDraft((prev) =>
            prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col],
        );
    };

    const effectiveYKeys = yKeysDraft.length > 0 ? yKeysDraft : yAxisKeys;

    const settingsModal = showSettings ? (
        <div
            className='settings-overlay'
        >
            <div
                className='settings-popup'
                onClick={(e) => e.stopPropagation()}
            >
                <div className='settings-popup-header'>
                    <div>
                        <h5>위젯 설정</h5>
                        <p>{title}</p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={() => setShowSettings(false)}
                    >
                        ✕
                    </button>
                </div>
                <div className='settings-popup-body'>
                    <div className='settings-section'>
                        <h6>위젯 정보</h6>
                        <div className='lc-settings-grid'>
                            <div className='lc-setting-group'>
                                <label>제목</label>
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(e) =>
                                        setTitleDraft(e.target.value)
                                    }
                                />
                            </div>
                            <div className='lc-setting-group'>
                                <label>엔드포인트</label>
                                <input
                                    type='text'
                                    value={endpointDraft}
                                    onChange={(e) =>
                                        setEndpointDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>데이터 설정</h6>
                        <div className='lc-settings-grid'>
                            <div className='lc-setting-group'>
                                <label>X축 (시간/카테고리)</label>
                                <select
                                    value={xKeyDraft || xAxisKey}
                                    onChange={(e) =>
                                        setXKeyDraft(e.target.value)
                                    }
                                >
                                    {detectedColumns.map((c) => (
                                        <option key={c} value={c}>
                                            {c}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className='lc-setting-group'>
                                <label>
                                    Y축 값{" "}
                                    <span className='lc-hint'>(다중 선택)</span>
                                </label>
                                <div className='lc-check-list'>
                                    {detectedColumns
                                        .filter(
                                            (c) =>
                                                c !== (xKeyDraft || xAxisKey),
                                        )
                                        .map((c) => (
                                            <label
                                                key={c}
                                                className='lc-check-item'
                                            >
                                                <input
                                                    type='checkbox'
                                                    checked={effectiveYKeys.includes(
                                                        c,
                                                    )}
                                                    onChange={() =>
                                                        toggleYKey(c)
                                                    }
                                                />
                                                {c}
                                            </label>
                                        ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>표시 설정</h6>
                        <div className='lc-settings-grid'>
                            <div className='lc-setting-group'>
                                <label>범례</label>
                                <label className='lc-check-item'>
                                    <input
                                        type='checkbox'
                                        checked={showLegend}
                                        onChange={(e) =>
                                            setShowLegend(e.target.checked)
                                        }
                                    />
                                    범례 표시
                                </label>
                            </div>
                            <div className='lc-setting-group'>
                                <label>
                                    최대 포인트 수{" "}
                                    <span className='lc-hint'>(50 – 10000)</span>
                                </label>
                                <input
                                    type='number'
                                    min='50'
                                    max='10000'
                                    value={maxPointsDraft}
                                    onChange={(e) =>
                                        setMaxPointsDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className='settings-inline-row'>
                        <div className='settings-section'>
                            <h6>위젯 크기</h6>
                            <div className='lc-setting-group'>
                                <div className='lc-size-row'>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minW ?? 2}
                                        max={sizeBounds?.maxW ?? 12}
                                        value={sizeDraft.w}
                                        onChange={(e) =>
                                            setSizeDraft((p) => ({
                                                ...p,
                                                w: e.target.value,
                                            }))
                                        }
                                        placeholder='W'
                                    />
                                    <span className='lc-size-sep'>×</span>
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? 2}
                                        max={sizeBounds?.maxH ?? 24}
                                        value={sizeDraft.h}
                                        onChange={(e) =>
                                            setSizeDraft((p) => ({
                                                ...p,
                                                h: e.target.value,
                                            }))
                                        }
                                        placeholder='H'
                                    />
                                </div>
                            </div>
                        </div>
                        <div className='settings-section'>
                            <h6>체크 주기 (초)</h6>
                            <div className='lc-setting-group'>
                                <input
                                    type='number'
                                    min='1'
                                    max='3600'
                                    value={intervalDraft}
                                    onChange={(e) =>
                                        setIntervalDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className='lc-settings-footer'>
                        <button
                            type='button'
                            className='secondary-btn'
                            onClick={() => setShowSettings(false)}
                        >
                            취소
                        </button>
                        <button
                            type='button'
                            className='primary-btn'
                            onClick={handleApplySettings}
                        >
                            적용
                        </button>
                    </div>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className='lc-card'>
            {/* Header */}
            <div className='api-card-header lc-header'>
                <div className='lc-header-left'>
                    <span className='lc-title'>{title}</span>
                    <span className={`status-pill ${statusLabel}`}>
                        <span className='status-dot' />
                        {statusLabel === "loading"
                            ? "..."
                            : statusLabel === "dead"
                              ? "DEAD"
                              : statusLabel === "slow-live"
                                ? "SLOW"
                                : "LIVE"}
                    </span>
                </div>
                <div className='lc-header-right'>
                    <div className='lc-time-ranges'>
                        {TIME_RANGES.map((r) => (
                            <button
                                key={r.key}
                                className={`lc-range-btn${timeRange === r.key ? " active" : ""}`}
                                onClick={() => handleTimeRangeChange(r.key)}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                    <button
                        className='lc-action-btn'
                        title='새로고침'
                        onClick={onRefresh}
                    >
                        ↻
                    </button>
                    <button
                        className='lc-action-btn'
                        title='설정'
                        onClick={() => setShowSettings((v) => !v)}
                    >
                        ⚙
                    </button>
                    <button
                        className='lc-action-btn lc-action-btn-danger'
                        title='삭제'
                        onClick={onRemove}
                    >
                        ✕
                    </button>
                </div>
            </div>

            {settingsModal && createPortal(settingsModal, document.body)}

            {/* Chart body */}
            <div className='lc-body'>
                {error ? (
                    <div className='lc-state lc-error'>⚠️ 오류: {error}</div>
                ) : loading ? (
                    <div className='lc-state'>
                        <div className='spinner' />
                    </div>
                ) : filteredRows.length === 0 ? (
                    <div className='lc-state lc-empty'>데이터가 없습니다</div>
                ) : (
                    <>
                        {isDownsampled && (
                            <div className='lc-downsample-notice'>
                                {filteredRows.length.toLocaleString()}개 →{" "}
                                {chartRows.length}포인트 표시 (다운샘플링)
                            </div>
                        )}
                        <ResponsiveContainer width='100%' height='100%'>
                            <LineChart
                                data={chartRows}
                                margin={{
                                    top: 6,
                                    right: 16,
                                    left: 0,
                                    bottom: 4,
                                }}
                            >
                                <CartesianGrid
                                    strokeDasharray='3 3'
                                    stroke='rgba(255,255,255,0.06)'
                                />
                                <XAxis
                                    dataKey={xAxisKey}
                                    tick={{ fill: "#7a90a8", fontSize: 11 }}
                                    tickLine={false}
                                    axisLine={{
                                        stroke: "rgba(255,255,255,0.08)",
                                    }}
                                    interval='preserveStartEnd'
                                />
                                <YAxis
                                    tick={{ fill: "#7a90a8", fontSize: 11 }}
                                    tickLine={false}
                                    axisLine={false}
                                    width={44}
                                />
                                <Tooltip content={<ChartTooltip />} />
                                {(chartSettings?.showLegend ?? true) && (
                                    <Legend
                                        wrapperStyle={{
                                            fontSize: 11,
                                            color: "#7a90a8",
                                            paddingTop: 2,
                                        }}
                                    />
                                )}
                                {yAxisKeys.map((key, i) => (
                                    <Line
                                        key={key}
                                        type='monotone'
                                        dataKey={key}
                                        stroke={
                                            CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ]
                                        }
                                        strokeWidth={2}
                                        dot={false}
                                        activeDot={{
                                            r: 5,
                                            strokeWidth: 0,
                                            fill: CHART_COLORS[
                                                i % CHART_COLORS.length
                                            ],
                                        }}
                                    />
                                ))}
                            </LineChart>
                        </ResponsiveContainer>
                    </>
                )}
            </div>
        </div>
    );
};

export default LineChartCard;
