import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
    countRowsMatchingCriteria,
    getEnabledCriteriaColumns,
} from "../utils/helpers";
import DynamicTable from "./DynamicTable";
import "./ApiCard.css";

const reorderItems = (items, fromIndex, toIndex) => {
    if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length
    ) {
        return items;
    }

    const nextItems = [...items];
    const [movedItem] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, movedItem);
    return nextItems;
};

const clamp = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

const normalizeData = (rawData) => {
    if (Array.isArray(rawData)) {
        return rawData;
    }

    if (typeof rawData === "object" && rawData !== null) {
        return Object.keys(rawData).map((key) => ({
            _key: key,
            ...rawData[key],
        }));
    }

    return [];
};

const getAllColumns = (rawData) => {
    const rows = normalizeData(rawData);
    const columnSet = new Set();

    rows.forEach((row) => {
        if (typeof row === "object" && row !== null) {
            Object.keys(row).forEach((key) => {
                if (!key.startsWith("_")) {
                    columnSet.add(key);
                }
            });
        }
    });

    return Array.from(columnSet);
};

const ApiCard = ({
    apiId,
    title,
    endpoint,
    data,
    loading,
    refreshing,
    error,
    apiStatus,
    onRemove,
    onRefresh,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    widgetFontSize,
    tableSettings,
    onTableSettingsChange,
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const [sizeDraft, setSizeDraft] = useState({ w: 4, h: 4 });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 5);
    const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
    const [selectedRow, setSelectedRow] = useState(null);
    const [clipboardRow, setClipboardRow] = useState(null);
    const [showAlertsOnly, setShowAlertsOnly] = useState(false);
    const [draggingColumn, setDraggingColumn] = useState(null);
    const [dragOverColumn, setDragOverColumn] = useState(null);
    const [titleDraft, setTitleDraft] = useState(title);
    const [endpointDraft, setEndpointDraft] = useState(endpoint);

    const dataRows = useMemo(() => normalizeData(data), [data]);
    const detectedColumns = useMemo(() => getAllColumns(data), [data]);
    const savedVisibleColumns = tableSettings?.visibleColumns ?? [];
    const availableColumns = useMemo(() => {
        const mergedColumns = new Set([
            ...savedVisibleColumns,
            ...detectedColumns,
        ]);
        return Array.from(mergedColumns);
    }, [detectedColumns, savedVisibleColumns]);

    const orderedColumns = useMemo(() => {
        const visibleSet = new Set(savedVisibleColumns);
        const visibleOrdered = savedVisibleColumns.filter((column) =>
            availableColumns.includes(column),
        );
        const hiddenColumns = availableColumns.filter(
            (column) => !visibleSet.has(column),
        );

        return [...visibleOrdered, ...hiddenColumns];
    }, [availableColumns, savedVisibleColumns]);

    useEffect(() => {
        if (detectedColumns.length === 0) return;

        const saved = tableSettings?.visibleColumns ?? [];

        // 초기 상태: 저장된 컬럼 없음 → detectedColumns 그대로 저장
        if (saved.length === 0) {
            onTableSettingsChange({ visibleColumns: detectedColumns });
            return;
        }

        // 백엔드 데이터셋에서 사라진 컬럼이 있으면 자동 갱신
        const hasDisappearedColumns = saved.some(
            (col) => !detectedColumns.includes(col),
        );
        if (hasDisappearedColumns) {
            // 살아남은 컬럼은 기존 순서 유지, 신규 컬럼은 뒤에 추가
            const surviving = saved.filter((col) =>
                detectedColumns.includes(col),
            );
            const newCols = detectedColumns.filter(
                (col) => !saved.includes(col),
            );
            onTableSettingsChange({
                visibleColumns: [...surviving, ...newCols],
            });
        }
    }, [detectedColumns, onTableSettingsChange, tableSettings?.visibleColumns]);

    const visibleColumns =
        tableSettings?.visibleColumns && tableSettings.visibleColumns.length > 0
            ? tableSettings.visibleColumns.filter((column) =>
                  availableColumns.includes(column),
              )
            : availableColumns;

    useEffect(() => {
        setSizeDraft({
            w: currentSize?.w ?? 4,
            h: currentSize?.h ?? 4,
        });
    }, [currentSize?.w, currentSize?.h]);

    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 5);
    }, [refreshIntervalSec]);

    useEffect(() => {
        if (data != null) {
            setLastUpdatedAt(new Date());
        }
    }, [data]);

    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    useEffect(() => {
        setEndpointDraft(endpoint);
    }, [endpoint]);

    const formatInterval = (sec) => {
        if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
        if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
        return `every ${sec}s`;
    };

    const formatLocalTime = (date) => {
        if (!date) return null;
        return date.toLocaleTimeString("en-GB", { hour12: false });
    };

    const columnWidths = tableSettings?.columnWidths ?? {};
    const [localColumnWidths, setLocalColumnWidths] = useState(columnWidths);
    const columnWidthTimerRef = useRef(null);

    // Sync local widths when external tableSettings change (e.g., from store load)
    useEffect(() => {
        setLocalColumnWidths(tableSettings?.columnWidths ?? {});
    }, [tableSettings?.columnWidths]);

    const criteriaMap = tableSettings?.criteria ?? {};
    const rowCount = dataRows.length;
    const enabledCriteriaColumns = useMemo(
        () => getEnabledCriteriaColumns(criteriaMap),
        [criteriaMap],
    );

    const alertCount = useMemo(() => {
        if (enabledCriteriaColumns.length === 0 || dataRows.length === 0) {
            return 0;
        }

        return countRowsMatchingCriteria(dataRows, criteriaMap);
    }, [criteriaMap, dataRows, enabledCriteriaColumns.length]);

    useEffect(() => {
        if (alertCount === 0) {
            setShowAlertsOnly(false);
        }
    }, [alertCount]);

    useEffect(() => {
        if (enabledCriteriaColumns.length === 0) {
            setShowAlertsOnly(false);
        }
    }, [enabledCriteriaColumns.length]);

    const statusLabel = loading
        ? "loading"
        : apiStatus === "dead"
          ? "dead"
          : apiStatus === "slow-live"
            ? "slow-live"
            : "live";

    const statusText = statusLabel === "slow-live" ? "live" : statusLabel;

    const handleColumnToggle = (column) => {
        const nextVisibleColumns = visibleColumns.includes(column)
            ? visibleColumns.filter((item) => item !== column)
            : [...visibleColumns, column];

        onTableSettingsChange({ visibleColumns: nextVisibleColumns });
    };

    const handleColumnDragStart = (event, column) => {
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", column);
        }
        setDraggingColumn(column);
        setDragOverColumn(column);
    };

    const handleColumnDrop = (targetColumn) => {
        if (!draggingColumn || draggingColumn === targetColumn) {
            setDraggingColumn(null);
            setDragOverColumn(null);
            return;
        }

        const fromIndex = orderedColumns.indexOf(draggingColumn);
        const toIndex = orderedColumns.indexOf(targetColumn);
        const reorderedColumns = reorderItems(
            orderedColumns,
            fromIndex,
            toIndex,
        );
        const nextVisibleColumns = reorderedColumns.filter((column) =>
            visibleColumns.includes(column),
        );

        onTableSettingsChange({ visibleColumns: nextVisibleColumns });
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragEnd = () => {
        setDraggingColumn(null);
        setDragOverColumn(null);
    };

    const handleColumnDragOver = (event, column) => {
        event.preventDefault();

        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
        }

        if (dragOverColumn !== column) {
            setDragOverColumn(column);
        }
    };

    const handleColumnDropEvent = (event, column) => {
        event.preventDefault();
        handleColumnDrop(column);
    };

    const handleColumnWidthChange = useCallback((column, width) => {
        const nextWidth = Number(width);
        const resolvedWidth = Number.isNaN(nextWidth)
            ? getDefaultColumnWidth(column)
            : nextWidth;

        // Update local state immediately for responsive UI
        setLocalColumnWidths((prev) => ({ ...prev, [column]: resolvedWidth }));

        // Debounce the store update to avoid flooding API calls
        if (columnWidthTimerRef.current) {
            clearTimeout(columnWidthTimerRef.current);
        }
        columnWidthTimerRef.current = setTimeout(() => {
            onTableSettingsChange({
                columnWidths: {
                    ...columnWidths,
                    [column]: resolvedWidth,
                },
            });
            columnWidthTimerRef.current = null;
        }, 300);
    }, [columnWidths, onTableSettingsChange]);

    const getDefaultColumnWidth = (column) => {
        const label = column
            .replace(/_/g, " ")
            .replace(/\b\w/g, (value) => value.toUpperCase());
        const estimatedWidth = label.length * 9 + 28;
        return Math.max(80, Math.min(420, estimatedWidth));
    };

    useEffect(() => {
        if (availableColumns.length === 0) {
            return;
        }

        const nextWidths = { ...columnWidths };
        let changed = false;

        availableColumns.forEach((column) => {
            if (!Number.isFinite(Number(nextWidths[column]))) {
                nextWidths[column] = getDefaultColumnWidth(column);
                changed = true;
            }
        });

        if (changed) {
            setLocalColumnWidths(nextWidths);
            onTableSettingsChange({ columnWidths: nextWidths });
        }
    }, [availableColumns]); // only run when columns change, not on every width update

    const criteriaTimerRef = useRef(null);
    const handleCriteriaChange = useCallback((column, patch) => {
        const nextCriteria = {
            ...criteriaMap,
            [column]: {
                enabled: criteriaMap[column]?.enabled ?? false,
                operator: criteriaMap[column]?.operator ?? ">=",
                value: criteriaMap[column]?.value ?? "",
                ...patch,
            },
        };

        if (criteriaTimerRef.current) {
            clearTimeout(criteriaTimerRef.current);
        }
        criteriaTimerRef.current = setTimeout(() => {
            onTableSettingsChange({ criteria: nextCriteria });
            criteriaTimerRef.current = null;
        }, 300);
    }, [criteriaMap, onTableSettingsChange]);

    const handleSizeApply = () => {
        const minW = sizeBounds?.minW ?? 2;
        const maxW = sizeBounds?.maxW ?? 12;
        const minH = sizeBounds?.minH ?? 2;
        const maxH = sizeBounds?.maxH ?? 24;

        const nextWidth = clamp(
            sizeDraft.w,
            minW,
            maxW,
            currentSize?.w ?? minW,
        );
        const nextHeight = clamp(
            sizeDraft.h,
            minH,
            maxH,
            currentSize?.h ?? minH,
        );

        setSizeDraft({ w: nextWidth, h: nextHeight });
        onSizeChange(nextWidth, nextHeight);
    };

    const handleIntervalApply = () => {
        const nextInterval = clamp(intervalDraft, 1, 3600, 5);
        setIntervalDraft(nextInterval);
        onRefreshIntervalChange(nextInterval);
    };

    const handleWidgetMetaApply = () => {
        const nextTitle = titleDraft.trim();
        const nextEndpoint = endpointDraft.trim();
        if (!nextTitle || !nextEndpoint) {
            return;
        }

        if (nextTitle === title && nextEndpoint === endpoint) {
            return;
        }

        onWidgetMetaChange?.({
            title: nextTitle,
            endpoint: nextEndpoint,
        });
    };

    // Ctrl+C: 단일 클릭으로 선택된 행을 헤더 포함 TSV로 클립보드에 복사
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "c" && clipboardRow) {
                const headers = visibleColumns.filter(
                    (c) => !c.startsWith("_"),
                );
                const values = headers.map((h) => {
                    const v = clipboardRow[h];
                    if (v === null || v === undefined) return "";
                    if (typeof v === "object") return JSON.stringify(v);
                    return String(v);
                });
                const tsv = headers.join("\t") + "\n" + values.join("\t");
                navigator.clipboard.writeText(tsv).catch(() => {});
                e.preventDefault();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [clipboardRow, visibleColumns]);

    // 선택된 행의 최신 데이터를 실시간으로 추적
    const liveSelectedRow = useMemo(() => {
        if (!selectedRow) return null;
        // _key 기준으로 매칭, 없으면 인덱스 기준
        if (selectedRow._key !== undefined) {
            return (
                dataRows.find((r) => r._key === selectedRow._key) ?? selectedRow
            );
        }
        const idx = dataRows.findIndex((r) =>
            Object.keys(selectedRow).every((k) => r[k] === selectedRow[k]),
        );
        return idx >= 0 ? dataRows[idx] : selectedRow;
    }, [selectedRow, dataRows]);

    const renderDetailValue = (value) => {
        if (value === null || value === undefined)
            return <span className='detail-null'>—</span>;
        if (typeof value === "boolean")
            return (
                <span
                    className={value ? "detail-bool-true" : "detail-bool-false"}
                >
                    {value ? "true" : "false"}
                </span>
            );
        if (typeof value === "object")
            return (
                <pre className='detail-json'>
                    {JSON.stringify(value, null, 2)}
                </pre>
            );
        if (typeof value === "number")
            return (
                <span className='detail-number'>{value.toLocaleString()}</span>
            );
        return <span className='detail-string'>{String(value)}</span>;
    };

    const rowDetailPopup = liveSelectedRow
        ? createPortal(
              <div
                  className='row-detail-overlay'
                  onClick={() => setSelectedRow(null)}
              >
                  <div
                      className='row-detail-popup'
                      onClick={(e) => e.stopPropagation()}
                  >
                      <div className='row-detail-header'>
                          <div>
                              <h5>Row Detail</h5>
                              <p>{title}</p>
                          </div>
                          <button
                              type='button'
                              className='close-settings-btn'
                              onClick={() => setSelectedRow(null)}
                          >
                              ✕
                          </button>
                      </div>
                      <div className='row-detail-body'>
                          <table className='row-detail-table'>
                              <tbody>
                                  {Object.entries(liveSelectedRow)
                                      .filter(([k]) => !k.startsWith("_"))
                                      .map(([key, value]) => (
                                          <tr
                                              key={key}
                                              className='row-detail-row'
                                          >
                                              <td className='row-detail-key'>
                                                  {key}
                                              </td>
                                              <td className='row-detail-val'>
                                                  {renderDetailValue(value)}
                                              </td>
                                          </tr>
                                      ))}
                              </tbody>
                          </table>
                      </div>
                      <div className='row-detail-footer'>
                          <span className='row-detail-live-indicator'>
                              <span className='live-dot' />
                              실시간 반영 중
                          </span>
                      </div>
                  </div>
              </div>,
              document.body,
          )
        : null;

    const settingsPopup = showSettings ? (
        <div
            className='settings-overlay'
        >
            <div
                className='settings-popup'
                onClick={(event) => event.stopPropagation()}
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
                        <div className='size-editor widget-meta-editor'>
                            <label>
                                Title
                                <input
                                    type='text'
                                    value={titleDraft}
                                    onChange={(event) =>
                                        setTitleDraft(event.target.value)
                                    }
                                />
                            </label>
                            <label>
                                Endpoint
                                <input
                                    type='text'
                                    value={endpointDraft}
                                    onChange={(event) =>
                                        setEndpointDraft(event.target.value)
                                    }
                                />
                            </label>
                            <button
                                type='button'
                                className='size-preset-btn'
                                onClick={handleWidgetMetaApply}
                            >
                                적용
                            </button>
                        </div>
                    </div>

                    <div className='settings-inline-row'>
                        <div className='settings-section'>
                            <h6>위젯 크기</h6>
                            <div className='size-editor widget-size-editor'>
                                <label>
                                    Width
                                    <input
                                        type='number'
                                        min={sizeBounds?.minW ?? 2}
                                        max={sizeBounds?.maxW ?? 12}
                                        value={sizeDraft.w}
                                        onChange={(event) =>
                                            setSizeDraft((previousDraft) => ({
                                                ...previousDraft,
                                                w: event.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <label>
                                    Height
                                    <input
                                        type='number'
                                        min={sizeBounds?.minH ?? 2}
                                        max={sizeBounds?.maxH ?? 24}
                                        value={sizeDraft.h}
                                        onChange={(event) =>
                                            setSizeDraft((previousDraft) => ({
                                                ...previousDraft,
                                                h: event.target.value,
                                            }))
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={handleSizeApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>

                        <div className='settings-section refresh-interval-section'>
                            <h6>API 리프레시 주기 (초)</h6>
                            <div className='refresh-interval-editor'>
                                <label className='refresh-interval-input-label'>
                                    <span>Interval</span>
                                    <input
                                        type='number'
                                        min='1'
                                        max='3600'
                                        value={intervalDraft}
                                        onChange={(event) =>
                                            setIntervalDraft(event.target.value)
                                        }
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='size-preset-btn'
                                    onClick={handleIntervalApply}
                                >
                                    적용
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>컬럼 표시 및 너비</h6>
                        <div className='column-settings-list'>
                            {orderedColumns.map((column) => (
                                <div
                                    key={column}
                                    className={`column-setting-row ${draggingColumn === column ? "dragging" : ""} ${dragOverColumn === column ? "drag-over" : ""}`}
                                    onDragOver={(event) =>
                                        handleColumnDragOver(event, column)
                                    }
                                    onDrop={(event) =>
                                        handleColumnDropEvent(event, column)
                                    }
                                >
                                    <button
                                        type='button'
                                        className='column-drag-handle'
                                        aria-label={`${column} 순서 이동`}
                                        title='드래그해서 표시 순서 변경'
                                        draggable
                                        onDragStart={(event) =>
                                            handleColumnDragStart(event, column)
                                        }
                                        onDragEnd={handleColumnDragEnd}
                                    >
                                        ⋮⋮
                                    </button>
                                    <label className='column-toggle'>
                                        <input
                                            type='checkbox'
                                            checked={visibleColumns.includes(
                                                column,
                                            )}
                                            onChange={() =>
                                                handleColumnToggle(column)
                                            }
                                        />
                                        <span>{column}</span>
                                    </label>

                                    <div className='column-width-controls'>
                                        <input
                                            type='range'
                                            min='80'
                                            max='420'
                                            step='10'
                                            value={
                                                localColumnWidths[column] ??
                                                getDefaultColumnWidth(column)
                                            }
                                            onChange={(event) =>
                                                handleColumnWidthChange(
                                                    column,
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <input
                                            type='number'
                                            min='80'
                                            max='420'
                                            step='10'
                                            value={
                                                localColumnWidths[column] ??
                                                getDefaultColumnWidth(column)
                                            }
                                            onChange={(event) =>
                                                handleColumnWidthChange(
                                                    column,
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        <span>px</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className='settings-section'>
                        <h6>이상 감지 Criteria (컬럼별)</h6>
                        <div className='criteria-settings-list'>
                            {availableColumns.map((column) => {
                                const criteria = criteriaMap[column] ?? {
                                    enabled: false,
                                    operator: ">=",
                                    value: "",
                                };

                                return (
                                    <div
                                        key={`${column}-criteria`}
                                        className='criteria-setting-row'
                                    >
                                        <label className='criteria-column-label'>
                                            <input
                                                type='checkbox'
                                                checked={!!criteria.enabled}
                                                onChange={(event) =>
                                                    handleCriteriaChange(
                                                        column,
                                                        {
                                                            enabled:
                                                                event.target
                                                                    .checked,
                                                        },
                                                    )
                                                }
                                            />
                                            <span>{column}</span>
                                        </label>

                                        <select
                                            value={criteria.operator ?? ">="}
                                            onChange={(event) =>
                                                handleCriteriaChange(column, {
                                                    operator:
                                                        event.target.value,
                                                })
                                            }
                                        >
                                            <option value='>'>&gt;</option>
                                            <option value='>='>&gt;=</option>
                                            <option value='<'>&lt;</option>
                                            <option value='<='>&lt;=</option>
                                            <option value='=='>==</option>
                                            <option value='!='>!=</option>
                                            <option value='contains'>
                                                contains
                                            </option>
                                            <option value='not_contains'>
                                                not_contains
                                            </option>
                                        </select>

                                        <input
                                            type='text'
                                            value={criteria.value ?? ""}
                                            onChange={(event) =>
                                                handleCriteriaChange(column, {
                                                    value: event.target.value,
                                                })
                                            }
                                            placeholder='임계값'
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        <span className='title-meta title-meta-rows'>
                            {rowCount} rows
                        </span>
                        <span className={`status-pill ${statusLabel}`}>
                            <span className='status-dot' />
                            {statusText}
                        </span>
                        {enabledCriteriaColumns.length > 0 && (
                            <button
                                type='button'
                                className={`alert-pill ${alertCount > 0 ? "has-alert" : "no-alert"}`}
                                title={`Criteria 조건 충족 row: ${alertCount}`}
                                onClick={() => {
                                    if (alertCount > 0) {
                                        setShowAlertsOnly(
                                            (previous) => !previous,
                                        );
                                    }
                                }}
                                aria-pressed={showAlertsOnly}
                                disabled={alertCount === 0}
                            >
                                ALERT {alertCount}
                                {showAlertsOnly ? " · ON" : ""}
                            </button>
                        )}
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRefresh();
                                }}
                                title='새로고침'
                            >
                                ⟳
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setShowSettings(true);
                                }}
                                title='설정'
                            >
                                ⚙
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRemove();
                                }}
                                title='제거'
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            <span className='api-endpoint'>{endpoint}</span>
                            <span className='refresh-interval-chip'>
                                ⏱ {formatInterval(refreshIntervalSec ?? 5)}
                            </span>
                        </div>
                        {lastUpdatedAt && (
                            <span className='last-updated-time'>
                                {formatLocalTime(lastUpdatedAt)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {settingsPopup && createPortal(settingsPopup, document.body)}
            {rowDetailPopup}

            <div className='api-card-content'>
                <DynamicTable
                    data={data}
                    title=''
                    columns={visibleColumns}
                    columnWidths={columnWidths}
                    criteria={criteriaMap}
                    showAlertsOnly={showAlertsOnly}
                    fontSize={widgetFontSize}
                    loading={loading}
                    error={error}
                    maxRows={20}
                    showHeader={false}
                    onRowClick={(row) => setClipboardRow(row)}
                    onRowDoubleClick={(row) => setSelectedRow(row)}
                />
            </div>
        </div>
    );
};

export default ApiCard;
