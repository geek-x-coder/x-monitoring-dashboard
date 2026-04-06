import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import "./BarChartCard.css";

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

// 개별 Cell 컬러링을 적용할 최대 row 수
// 초과 시 단일 색상으로 전환하여 React reconciliation 부하 감소
const CELL_COLOR_THRESHOLD = 30;
// 애니메이션을 비활성화할 최대 row 수
const ANIMATION_THRESHOLD = 100;
// 기본 최대 표시 막대 수
const MAX_BARS_DEFAULT = 200;

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
        <div className='bc-tooltip'>
            <p className='bc-tooltip-label'>{String(label)}</p>
            {payload.map((entry) => (
                <div
                    key={entry.dataKey ?? entry.name}
                    className='bc-tooltip-row'
                    style={{ color: entry.fill ?? entry.color }}
                >
                    <span className='bc-tooltip-name'>{entry.name}</span>
                    <span className='bc-tooltip-value'>
                        {typeof entry.value === "number"
                            ? entry.value.toLocaleString()
                            : String(entry.value ?? "—")}
                    </span>
                </div>
            ))}
        </div>
    );
};

const BarChartCard = ({
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
    // "vertical" = 세로 막대(기본), "horizontal" = 가로 막대
    const [orientation, setOrientation] = useState(
        chartSettings?.orientation ?? "vertical",
    );
    const [xKeyDraft, setXKeyDraft] = useState(chartSettings?.xAxisKey ?? "");
    const [yKeysDraft, setYKeysDraft] = useState(
        chartSettings?.yAxisKeys ?? [],
    );
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 4,
    });
    const [maxBars, setMaxBars] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );
    const [maxBarsDraft, setMaxBarsDraft] = useState(
        chartSettings?.maxBars ?? MAX_BARS_DEFAULT,
    );

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
        if (chartSettings?.orientation)
            setOrientation(chartSettings.orientation);
    }, [chartSettings?.orientation]);
    useEffect(() => {
        if (chartSettings?.maxBars != null) {
            setMaxBars(chartSettings.maxBars);
            setMaxBarsDraft(chartSettings.maxBars);
        }
    }, [chartSettings?.maxBars]);

    const rows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => detectColumns(rows), [rows]);

    // 최대 표시 개수 제한 — 초과분은 잘라내어 렌더링 부하 방지
    const chartRows = useMemo(
        () => (rows.length > maxBars ? rows.slice(0, maxBars) : rows),
        [rows, maxBars],
    );
    const truncated = rows.length > maxBars;

    const xAxisKey =
        chartSettings?.xAxisKey ||
        (detectedColumns.length > 0 ? detectedColumns[0] : "");
    const yAxisKeys =
        chartSettings?.yAxisKeys?.length > 0
            ? chartSettings.yAxisKeys
            : detectedColumns.filter((c) => c !== xAxisKey).slice(0, 4);

    const isHorizontal = orientation === "horizontal";
    // recharts convention: layout="vertical" → horizontal bars, layout="horizontal" → vertical bars
    const rechartsLayout = isHorizontal ? "vertical" : "horizontal";

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const effectiveYKeys = yKeysDraft.length > 0 ? yKeysDraft : yAxisKeys;

    const singleYMode = yAxisKeys.length === 1;
    // 대량 데이터에서 개별 Cell 컬러링은 수백 개의 React 컴포넌트를 생성하므로
    // 임계값 초과 시 단일 색상으로 전환
    const useCellColors = singleYMode && chartRows.length <= CELL_COLOR_THRESHOLD;
    // 대량 데이터에서 입장/퇴장 애니메이션은 렌더링 비용이 높으므로 비활성화
    const animationActive = chartRows.length <= ANIMATION_THRESHOLD;

    const handleApplySettings = () => {
        const resolvedX = xKeyDraft || xAxisKey;
        const resolvedY =
            yKeysDraft.length > 0
                ? yKeysDraft
                : detectedColumns.filter((c) => c !== resolvedX).slice(0, 4);

        const clampedMaxBars = Math.min(
            5000,
            Math.max(10, Math.floor(Number(maxBarsDraft) || MAX_BARS_DEFAULT)),
        );
        setMaxBars(clampedMaxBars);
        setMaxBarsDraft(clampedMaxBars);

        onChartSettingsChange?.({
            xAxisKey: resolvedX,
            yAxisKeys: resolvedY,
            orientation,
            maxBars: clampedMaxBars,
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
                        <div className='bc-settings-grid'>
                            <div className='bc-setting-group'>
                                <label>제목</label>
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(e) =>
                                        setTitleDraft(e.target.value)
                                    }
                                />
                            </div>
                            <div className='bc-setting-group'>
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
                        <div className='bc-settings-grid'>
                            <div className='bc-setting-group'>
                                <label>기준 컬럼 (카테고리)</label>
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
                            <div className='bc-setting-group'>
                                <label>
                                    수량 컬럼{" "}
                                    <span className='bc-hint'>(다중 선택)</span>
                                </label>
                                <div className='bc-check-list'>
                                    {detectedColumns
                                        .filter(
                                            (c) =>
                                                c !== (xKeyDraft || xAxisKey),
                                        )
                                        .map((c) => (
                                            <label
                                                key={c}
                                                className='bc-check-item'
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
                        <h6>방향</h6>
                        <div className='bc-radio-row'>
                            <label className='bc-radio-item'>
                                <input
                                    type='radio'
                                    name='bc-orientation'
                                    value='vertical'
                                    checked={orientation === "vertical"}
                                    onChange={() => setOrientation("vertical")}
                                />
                                세로 막대
                            </label>
                            <label className='bc-radio-item'>
                                <input
                                    type='radio'
                                    name='bc-orientation'
                                    value='horizontal'
                                    checked={orientation === "horizontal"}
                                    onChange={() =>
                                        setOrientation("horizontal")
                                    }
                                />
                                가로 막대
                            </label>
                        </div>
                    </div>

                    <div className='settings-inline-row'>
                        <div className='settings-section'>
                            <h6>위젯 크기</h6>
                            <div className='bc-setting-group'>
                                <div className='bc-size-row'>
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
                                    <span className='bc-size-sep'>×</span>
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
                            <div className='bc-setting-group'>
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
                        <div className='settings-section'>
                            <h6>최대 표시 항목</h6>
                            <div className='bc-setting-group'>
                                <input
                                    type='number'
                                    min='10'
                                    max='5000'
                                    value={maxBarsDraft}
                                    onChange={(e) =>
                                        setMaxBarsDraft(e.target.value)
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    <div className='bc-settings-footer'>
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
        <div className='bc-card'>
            {/* Header */}
            <div className='api-card-header bc-header'>
                <div className='bc-header-left'>
                    <span className='bc-title'>{title}</span>
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
                <div className='bc-header-right'>
                    <button
                        className='bc-action-btn'
                        title={isHorizontal ? "가로 막대 (클릭: 세로 전환)" : "세로 막대 (클릭: 가로 전환)"}
                        onClick={() => {
                            const next = isHorizontal ? "vertical" : "horizontal";
                            setOrientation(next);
                            onChartSettingsChange?.({ orientation: next });
                        }}
                    >
                        <span className={`bc-orient-icon${isHorizontal ? "" : " rotated"}`}>≡</span>
                    </button>
                    <button
                        className='bc-action-btn'
                        title='새로고침'
                        onClick={onRefresh}
                    >
                        ↻
                    </button>
                    <button
                        className='bc-action-btn'
                        title='설정'
                        onClick={() => setShowSettings((v) => !v)}
                    >
                        ⚙
                    </button>
                    <button
                        className='bc-action-btn bc-action-btn-danger'
                        title='삭제'
                        onClick={onRemove}
                    >
                        ✕
                    </button>
                </div>
            </div>

            {settingsModal && createPortal(settingsModal, document.body)}

            {/* Chart body */}
            <div className='bc-body'>
                {error ? (
                    <div className='bc-state bc-error'>⚠️ 오류: {error}</div>
                ) : loading ? (
                    <div className='bc-state'>
                        <div className='bc-spinner' />
                    </div>
                ) : chartRows.length === 0 ? (
                    <div className='bc-state bc-empty'>데이터가 없습니다</div>
                ) : (
                    <>
                        {truncated && (
                            <div className='bc-truncation-notice'>
                                상위 {maxBars.toLocaleString()}개 표시 중 (전체{" "}
                                {rows.length.toLocaleString()}개)
                            </div>
                        )}
                        <ResponsiveContainer width='100%' height='100%'>
                            <BarChart
                                layout={rechartsLayout}
                                data={chartRows}
                                margin={{ top: 6, right: 16, left: 0, bottom: truncated ? 0 : 4 }}
                            >
                                <CartesianGrid
                                    strokeDasharray='3 3'
                                    stroke='rgba(255,255,255,0.06)'
                                />
                                {isHorizontal ? (
                                    <>
                                        <XAxis
                                            type='number'
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            type='category'
                                            dataKey={xAxisKey}
                                            tick={{ fill: "#7a90a8", fontSize: 11 }}
                                            tickLine={false}
                                            axisLine={{
                                                stroke: "rgba(255,255,255,0.08)",
                                            }}
                                            width={80}
                                        />
                                    </>
                                ) : (
                                    <>
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
                                    </>
                                )}
                                <Tooltip content={<ChartTooltip />} cursor={{ fill: "transparent" }} />
                                {yAxisKeys.length > 1 && (
                                    <Legend
                                        wrapperStyle={{
                                            fontSize: 11,
                                            color: "#7a90a8",
                                            paddingTop: 2,
                                        }}
                                    />
                                )}
                                {yAxisKeys.map((key, i) =>
                                    useCellColors ? (
                                        // 소량 데이터: 막대별 개별 색상
                                        <Bar
                                            key={key}
                                            dataKey={key}
                                            isAnimationActive={animationActive}
                                            radius={
                                                isHorizontal
                                                    ? [0, 4, 4, 0]
                                                    : [4, 4, 0, 0]
                                            }
                                            maxBarSize={40}
                                            activeBar={{ fillOpacity: 0.75, stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
                                        >
                                            {chartRows.map((_, idx) => (
                                                <Cell
                                                    key={idx}
                                                    fill={
                                                        CHART_COLORS[
                                                            idx %
                                                                CHART_COLORS.length
                                                        ]
                                                    }
                                                />
                                            ))}
                                        </Bar>
                                    ) : (
                                        // 대량 데이터: 단일/계열 색상 (Cell 컴포넌트 생성 없음)
                                        <Bar
                                            key={key}
                                            dataKey={key}
                                            fill={
                                                CHART_COLORS[
                                                    i % CHART_COLORS.length
                                                ]
                                            }
                                            isAnimationActive={animationActive}
                                            radius={
                                                isHorizontal
                                                    ? [0, 4, 4, 0]
                                                    : [4, 4, 0, 0]
                                            }
                                            maxBarSize={singleYMode ? 40 : 32}
                                            activeBar={{ fillOpacity: 0.75, stroke: "rgba(255,255,255,0.18)", strokeWidth: 1 }}
                                        />
                                    ),
                                )}
                            </BarChart>
                        </ResponsiveContainer>
                    </>
                )}
            </div>
        </div>
    );
};

export default BarChartCard;
