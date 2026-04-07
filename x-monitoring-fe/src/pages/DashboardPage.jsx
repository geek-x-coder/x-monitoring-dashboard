import React, { useEffect, useMemo, useState } from "react";
import { WidthProvider, Responsive } from "react-grid-layout/legacy";
import { useNavigate } from "react-router-dom";
import { useWidgetApiData } from "../hooks/useApi";
import {
    dashboardService,
    getRememberedApiBaseUrl,
    rememberApiBaseUrl,
    resolveEndpointWithBase,
} from "../services/api";
import { API_BASE_URL as BUILDTIME_API_BASE_URL } from "../services/http";
import {
    countRowsMatchingCriteria,
    getEnabledCriteriaColumns,
    normalizeToArray,
} from "../utils/helpers";
import { useDashboardStore } from "../store/dashboardStore";
import { useAuthStore } from "../store/authStore";
import { useAlarmStore, SOUND_TYPES } from "../store/alarmStore";
import ApiCard from "../components/ApiCard";
import HealthCheckCard from "../components/HealthCheckCard";
import LineChartCard from "../components/LineChartCard";
import BarChartCard from "../components/BarChartCard";
import StatusListCard from "../components/StatusListCard";
import AlarmBanner from "../components/AlarmBanner";
import NetworkTestCard from "../components/NetworkTestCard";
import ServerResourceCard from "../components/ServerResourceCard";
import SqlEditorModal from "../components/SqlEditorModal";
import ConfigEditorModal from "../components/ConfigEditorModal";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./DashboardPage.css";

const ResponsiveGridLayout = WidthProvider(Responsive);
const MIN_WIDGET_W = 2;
const MAX_WIDGET_W = 12;
const MIN_WIDGET_H = 2;
const MAX_WIDGET_H = 24;
const DEFAULT_REFRESH_INTERVAL_SEC = 5;
const DEFAULT_WIDGET_FONT_SIZE = 13;
const DEFAULT_CONTENT_ZOOM = 100;
const MIN_CONTENT_ZOOM = 50;
const MAX_CONTENT_ZOOM = 150;
const ZOOM_STEP = 10;
// 빌드 시점 기본 URL 해석은 services/http.js에 일원화되어 있다.
// (VITE_API_URL이 명시적 빈 문자열이면 same-origin 모드 → window.location.origin)
// localStorage에 저장된 값이 있으면 그것을 우선한다.
const API_BASE_URL = getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;
const WIDGET_TYPE_TABLE = "table";
const WIDGET_TYPE_HEALTH_CHECK = "health-check";
const WIDGET_TYPE_LINE_CHART = "line-chart";
const WIDGET_TYPE_BAR_CHART = "bar-chart";
const WIDGET_TYPE_STATUS_LIST = "status-list";
const WIDGET_TYPE_NETWORK_TEST = "network-test";
const WIDGET_TYPE_SERVER_RESOURCE = "server-resource";

const parseStatusListInput = (rawValue, baseUrl) => {
    return String(rawValue ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const [rawLabel, ...rawUrlTokens] = line.includes("|")
                ? line.split("|")
                : ["", line];
            const urlValue =
                rawUrlTokens.length > 0 ? rawUrlTokens.join("|") : rawLabel;
            const normalizedUrl = resolveEndpointWithBase(
                urlValue.trim(),
                baseUrl,
            );
            const fallbackLabel = (() => {
                try {
                    const parsedUrl = new URL(normalizedUrl);
                    return parsedUrl.pathname || normalizedUrl;
                } catch {
                    return normalizedUrl;
                }
            })();

            return {
                id: `status-list-item-${index}-${normalizedUrl}`,
                label:
                    (rawUrlTokens.length > 0
                        ? rawLabel
                        : fallbackLabel
                    ).trim() || fallbackLabel,
                url: normalizedUrl,
            };
        })
        .filter((item) => item.url);
};

const createStatusListWidget = (baseUrl = API_BASE_URL) => ({
    id: "api-status-list",
    type: WIDGET_TYPE_STATUS_LIST,
    title: "API Status List",
    endpoints: [
        { id: "status-health", label: "Health", url: `${baseUrl}/health` },
        {
            id: "status-endpoints",
            label: "Endpoint Catalog",
            url: `${baseUrl}/dashboard/endpoints`,
        },
        {
            id: "status-logs",
            label: "Log Dates",
            url: `${baseUrl}/logs/available-dates`,
        },
    ],
    defaultLayout: {
        x: 0,
        y: 5,
        w: 4,
        h: 5,
        minW: MIN_WIDGET_W,
        minH: MIN_WIDGET_H,
    },
    refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
});

const DEFAULT_APIS = [
    {
        id: "api-1",
        type: WIDGET_TYPE_TABLE,
        title: "CoinTrader Status",
        endpoint: `${API_BASE_URL}/api/status`,
        defaultLayout: {
            x: 0,
            y: 0,
            w: 4,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-2",
        type: WIDGET_TYPE_TABLE,
        title: "Application Alerts",
        endpoint: `${API_BASE_URL}/api/alerts`,
        defaultLayout: {
            x: 4,
            y: 0,
            w: 4,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-3",
        type: WIDGET_TYPE_TABLE,
        title: "System Metrics",
        endpoint: `${API_BASE_URL}/api/metrics`,
        defaultLayout: {
            x: 8,
            y: 0,
            w: 4,
            h: 5,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    // createStatusListWidget(API_BASE_URL),
];

const DEFAULT_WIDGET_LAYOUT = {
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    minW: MIN_WIDGET_W,
    minH: MIN_WIDGET_H,
};
const GRID_COLUMNS = 12;

const clampValue = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

const normalizeWidgetLayout = (widget, savedLayout) => {
    const fallbackLayout = widget.defaultLayout ?? DEFAULT_WIDGET_LAYOUT;

    return {
        i: widget.id,
        ...fallbackLayout,
        ...savedLayout,
        minW:
            savedLayout?.minW ??
            fallbackLayout.minW ??
            DEFAULT_WIDGET_LAYOUT.minW,
        minH:
            savedLayout?.minH ??
            fallbackLayout.minH ??
            DEFAULT_WIDGET_LAYOUT.minH,
    };
};

const layoutArrayToMap = (layoutItems, previousLayouts = {}) => {
    return layoutItems.reduce((accumulator, item) => {
        accumulator[item.i] = {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            minW: previousLayouts[item.i]?.minW ?? MIN_WIDGET_W,
            minH: previousLayouts[item.i]?.minH ?? MIN_WIDGET_H,
        };
        return accumulator;
    }, {});
};

const DashboardPage = () => {
    const navigate = useNavigate();
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);
    const widgets = useDashboardStore((state) => state.widgets);
    const layouts = useDashboardStore((state) => state.layouts);
    const setWidgets = useDashboardStore((state) => state.setWidgets);
    const addWidget = useDashboardStore((state) => state.addWidget);
    const removeWidget = useDashboardStore((state) => state.removeWidget);
    const updateWidget = useDashboardStore((state) => state.updateWidget);
    const saveLayout = useDashboardStore((state) => state.saveLayout);
    const saveLayouts = useDashboardStore((state) => state.saveLayouts);
    const dashboardSettings = useDashboardStore(
        (state) => state.dashboardSettings,
    );
    const setDashboardSettings = useDashboardStore(
        (state) => state.setDashboardSettings,
    );
    const exportDashboardConfig = useDashboardStore(
        (state) => state.exportDashboardConfig,
    );
    const importDashboardConfig = useDashboardStore(
        (state) => state.importDashboardConfig,
    );

    // 빌드 시점 기본값 해석은 services/http.js에 일원화 (same-origin 모드 포함)
    const rememberedApiBaseUrl =
        getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

    const [showAddApi, setShowAddApi] = useState(false);
    const [showDashboardSettings, setShowDashboardSettings] = useState(false);
    const [showSqlEditor, setShowSqlEditor] = useState(false);
    const [showConfigEditor, setShowConfigEditor] = useState(false);
    const [newApiForm, setNewApiForm] = useState({
        title: "",
        endpoint: `${rememberedApiBaseUrl}/api/`,
        type: WIDGET_TYPE_TABLE,
        endpointsText: `${rememberedApiBaseUrl}/health\n${rememberedApiBaseUrl}/dashboard/endpoints`,
    });
    const [fontSizeDraft, setFontSizeDraft] = useState(
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const [zoomDraft, setZoomDraft] = useState(
        dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM,
    );
    const [configJsonDraft, setConfigJsonDraft] = useState("");
    const [configErrorMessage, setConfigErrorMessage] = useState("");
    const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(rememberedApiBaseUrl);
    const [apiBaseUrlSaved, setApiBaseUrlSaved] = useState(false);
    const [backendVersion, setBackendVersion] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const fetchBackendVersion = async () => {
            try {
                const res = await dashboardService.getApiData(null, "/health");
                if (!cancelled && res?.version) setBackendVersion(res.version);
            } catch { /* ignore */ }
        };
        fetchBackendVersion();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        setFontSizeDraft(
            dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
        );
    }, [dashboardSettings?.widgetFontSize]);

    useEffect(() => {
        setZoomDraft(dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM);
    }, [dashboardSettings?.contentZoom]);

    useEffect(() => {
        if (widgets !== null) {
            return;
        }
        // 최초 로드(localStorage 없음)일 때만 기본 위젯 세트를 추가
        const statusListWidget = createStatusListWidget(rememberedApiBaseUrl);
        const initial = [...DEFAULT_APIS, statusListWidget];
        setWidgets(initial);
        saveLayout(statusListWidget.id, statusListWidget.defaultLayout);
    }, [widgets, setWidgets, saveLayout, rememberedApiBaseUrl]);

    const dashboardWidgets = widgets ?? DEFAULT_APIS;
    const isAdmin =
        user?.role === "admin" ||
        String(user?.username || "")
            .trim()
            .toLowerCase() === "admin";

    const reportWidgetStatus = useAlarmStore((state) => state.reportWidgetStatus);
    const alarmSound      = useAlarmStore((state) => state.alarmSound);
    const setAlarmSound   = useAlarmStore((state) => state.setAlarmSound);
    const soundEnabled    = useAlarmStore((state) => state.soundEnabled);
    const setSoundEnabled = useAlarmStore((state) => state.setSoundEnabled);

    const { results, loadingMap, refreshingMap, refetchAll, refetchOne } =
        useWidgetApiData(dashboardWidgets);

    // Report alarm status via useEffect (must NOT be called during render)
    // Includes criteria-based alerts: if a table widget has alertCount > 0, treat as alarm
    useEffect(() => {
        dashboardWidgets.forEach((widget) => {
            // Skip widgets that manage their own alarm via onAlarmChange
            if (widget.type === WIDGET_TYPE_SERVER_RESOURCE || widget.type === WIDGET_TYPE_NETWORK_TEST) return;

            const status = results[widget.id]?.status ?? "loading";
            // dead: 완전 실패 / slow-live: status-list에서 일부 NG → 둘 다 alarm 발생
            let alarmStatus = (status === "dead" || status === "slow-live") ? "dead" : status;

            // Check criteria-based alerts for table widgets
            if (alarmStatus !== "dead" && widget.type === "table" && widget.tableSettings?.criteria) {
                const criteriaMap = widget.tableSettings.criteria;
                const enabledCols = getEnabledCriteriaColumns(criteriaMap);
                if (enabledCols.length > 0) {
                    const data = results[widget.id]?.data;
                    if (data) {
                        const rows = normalizeToArray(data);
                        const alertCount = countRowsMatchingCriteria(rows, criteriaMap);
                        if (alertCount > 0) {
                            alarmStatus = "dead";
                        }
                    }
                }
            }

            reportWidgetStatus(widget.id, alarmStatus);
        });
    }, [results, dashboardWidgets, reportWidgetStatus]);

    const gridLayout = useMemo(
        () =>
            dashboardWidgets.map((widget) =>
                normalizeWidgetLayout(widget, layouts[widget.id]),
            ),
        [dashboardWidgets, layouts],
    );

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const handleRemoveApi = (apiId) => {
        reportWidgetStatus(apiId, "live");
        removeWidget(apiId);
    };

    const handleAddApi = () => {
        if (!newApiForm.title.trim()) {
            return;
        }

        const isStatusListWidget = newApiForm.type === WIDGET_TYPE_STATUS_LIST;
        const isNetworkTestWidget = newApiForm.type === WIDGET_TYPE_NETWORK_TEST;
        const isServerResourceWidget = newApiForm.type === WIDGET_TYPE_SERVER_RESOURCE;
        const needsEndpoint = !isStatusListWidget && !isNetworkTestWidget && !isServerResourceWidget;
        if (needsEndpoint && !newApiForm.endpoint.trim()) {
            return;
        }

        const statusListEndpoints = isStatusListWidget
            ? parseStatusListInput(
                  newApiForm.endpointsText,
                  rememberedApiBaseUrl,
              )
            : [];
        if (isStatusListWidget && statusListEndpoints.length === 0) {
            return;
        }

        const widgetId = `api-${Date.now()}`;
        const nextLayout = {
            ...DEFAULT_WIDGET_LAYOUT,
            y: dashboardWidgets.length * 4,
        };
        const isChartType =
            newApiForm.type === WIDGET_TYPE_LINE_CHART ||
            newApiForm.type === WIDGET_TYPE_BAR_CHART;
        const newWidget = {
            id: widgetId,
            type: newApiForm.type,
            title: newApiForm.title.trim(),
            endpoint: needsEndpoint
                ? resolveEndpointWithBase(
                      newApiForm.endpoint.trim(),
                      rememberedApiBaseUrl,
                  )
                : undefined,
            defaultLayout: nextLayout,
            refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
            endpoints: isStatusListWidget ? statusListEndpoints : undefined,
            tableSettings:
                newApiForm.type === WIDGET_TYPE_TABLE
                    ? { visibleColumns: [], columnWidths: {}, criteria: {} }
                    : undefined,
            chartSettings: isChartType
                ? {
                      xAxisKey: "",
                      yAxisKeys: [],
                      timeRange: "all",
                      orientation: "vertical",
                  }
                : undefined,
            serverConfig: isServerResourceWidget
                ? { servers: [] }
                : undefined,
            networkConfig: isNetworkTestWidget
                ? { targets: [] }
                : undefined,
        };

        addWidget(newWidget);
        saveLayout(widgetId, nextLayout);
        setNewApiForm({
            title: "",
            endpoint: `${rememberedApiBaseUrl}/api/`,
            type: WIDGET_TYPE_TABLE,
            endpointsText: `${rememberedApiBaseUrl}/health\n${rememberedApiBaseUrl}/dashboard/endpoints`,
        });
        setShowAddApi(false);
    };

    const handleWidgetMetaChange = (apiId, updates) => {
        const targetWidget = dashboardWidgets.find(
            (widget) => widget.id === apiId,
        );
        if (!targetWidget) {
            return;
        }

        const nextTitle = String(
            updates?.title ?? targetWidget.title ?? "",
        ).trim();
        if (!nextTitle) {
            return;
        }

        // Types that don't have an endpoint field — just update title
        if (
            targetWidget.type === WIDGET_TYPE_STATUS_LIST ||
            targetWidget.type === WIDGET_TYPE_NETWORK_TEST ||
            targetWidget.type === WIDGET_TYPE_SERVER_RESOURCE
        ) {
            updateWidget(apiId, { title: nextTitle });
            return;
        }


        const nextEndpoint = String(
            updates?.endpoint ?? targetWidget.endpoint ?? "",
        ).trim();
        if (!nextEndpoint) {
            return;
        }

        updateWidget(apiId, {
            title: nextTitle,
            endpoint: resolveEndpointWithBase(
                nextEndpoint,
                rememberedApiBaseUrl,
            ),
        });
    };

    const handleStatusListEndpointsChange = (apiId, endpoints) => {
        updateWidget(apiId, { endpoints });
    };

    const isBackendManagedEndpoint = (endpointValue) => {
        if (!endpointValue) {
            return false;
        }

        try {
            const targetUrl = new URL(
                resolveEndpointWithBase(endpointValue, rememberedApiBaseUrl),
            );
            const baseUrl = new URL(rememberedApiBaseUrl);
            return (
                targetUrl.origin === baseUrl.origin &&
                targetUrl.pathname.startsWith("/api/")
            );
        } catch {
            return false;
        }
    };

    const handleManualRefresh = async (widget) => {
        if (
            widget?.type !== WIDGET_TYPE_STATUS_LIST &&
            isBackendManagedEndpoint(widget?.endpoint)
        ) {
            try {
                await dashboardService.refreshEndpointCache({
                    endpoint: widget.endpoint,
                    resetConnection: true,
                });
            } catch (error) {
                console.warn(
                    "Cache refresh failed before manual widget refresh",
                    error,
                );
            }
        }

        await refetchOne(widget.id);
    };

    const handleLayoutCommit = (nextLayout) => {
        const nextLayoutMap = layoutArrayToMap(nextLayout, layouts);
        saveLayouts({ ...layouts, ...nextLayoutMap });
    };

    const handleWidgetSizeChange = (apiId, nextWidth, nextHeight) => {
        const currentLayout =
            layouts[apiId] ??
            gridLayout.find((item) => item.i === apiId) ??
            DEFAULT_WIDGET_LAYOUT;

        const width = clampValue(
            nextWidth,
            currentLayout.minW ?? MIN_WIDGET_W,
            MAX_WIDGET_W,
            currentLayout.w,
        );
        const height = clampValue(
            nextHeight,
            currentLayout.minH ?? MIN_WIDGET_H,
            MAX_WIDGET_H,
            currentLayout.h,
        );

        saveLayout(apiId, {
            ...currentLayout,
            w: width,
            h: height,
        });
    };

    const handleRefreshIntervalChange = (apiId, intervalSec) => {
        const normalizedInterval = clampValue(
            intervalSec,
            1,
            3600,
            DEFAULT_REFRESH_INTERVAL_SEC,
        );

        updateWidget(apiId, {
            refreshIntervalSec: normalizedInterval,
        });
    };

    const handleTableSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            tableSettings: nextSettings,
        });
    };

    const handleChartSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            chartSettings: nextSettings,
        });
    };

    const handleApplyDashboardSettings = () => {
        const normalizedFontSize = clampValue(
            fontSizeDraft,
            10,
            18,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        const normalizedZoom = clampValue(
            zoomDraft,
            MIN_CONTENT_ZOOM,
            MAX_CONTENT_ZOOM,
            DEFAULT_CONTENT_ZOOM,
        );

        setFontSizeDraft(normalizedFontSize);
        setZoomDraft(normalizedZoom);
        setDashboardSettings({
            widgetFontSize: normalizedFontSize,
            contentZoom: normalizedZoom,
        });
    };

    const handleApplyApiBaseUrl = () => {
        const trimmed = apiBaseUrlDraft.trim().replace(/\/+$/, "");
        if (!trimmed) return;
        rememberApiBaseUrl(trimmed);
        setApiBaseUrlSaved(true);
        setTimeout(() => setApiBaseUrlSaved(false), 2000);
        window.location.reload();
    };

    const handleExportConfig = () => {
        const exportedConfig = exportDashboardConfig();
        const prettyJson = JSON.stringify(exportedConfig, null, 2);
        setConfigJsonDraft(prettyJson);

        const blob = new Blob([prettyJson], { type: "application/json" });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `dashboard-config-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
    };

    const handleImportConfigFromText = () => {
        try {
            const parsed = JSON.parse(configJsonDraft);
            importDashboardConfig(parsed);
            setConfigErrorMessage("");
            setShowDashboardSettings(false);
        } catch (error) {
            setConfigErrorMessage(
                error instanceof Error
                    ? error.message
                    : "설정 JSON 파싱에 실패했습니다.",
            );
        }
    };

    const handleConfigFileChange = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result ?? "");
            setConfigJsonDraft(text);
        };
        reader.readAsText(file, "utf-8");
        event.target.value = "";
    };

    const getApiResult = (apiId) => results[apiId];

    const getApiData = (apiId) => {
        const apiResult = getApiResult(apiId);
        if (!apiResult) return null;
        return apiResult.data ?? null;
    };

    return (
        <div className='dashboard-page'>
            <header className='dashboard-header'>
                <div className='header-left'>
                    <h1>📊 Monitoring Dashboard</h1>
                    <div className='header-subtitle-row'>
                        <p>Real-time Application Status &amp; Alerts</p>
                        <span
                            className='api-count'
                            title={`위젯 ${dashboardWidgets.length}개`}
                        >
                            <span className='api-count-icon'>◫</span>
                            <span className='api-count-value'>
                                {dashboardWidgets.length}
                            </span>
                        </span>
                    </div>
                </div>

                <div className='header-right'>
                    <div className='header-info-row'>
                        <span className='header-user-id'>
                            @{user?.username || "administrator"}
                        </span>
                        <button
                            className='logout-btn icon'
                            onClick={handleLogout}
                            title='로그아웃'
                        >
                            ⎋
                        </button>
                    </div>

                    <div className='header-controls-row'>
                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={() => setShowDashboardSettings(true)}
                            title='대시보드 설정'
                        >
                            <svg className='toolbar-btn-icon' width='14' height='14' viewBox='0 0 14 14' fill='currentColor'>
                                <rect x='0' y='0' width='6' height='6' rx='1.2' />
                                <rect x='8' y='0' width='6' height='6' rx='1.2' />
                                <rect x='0' y='8' width='6' height='6' rx='1.2' />
                                <rect x='8' y='8' width='6' height='6' rx='1.2' />
                            </svg>
                        </button>
                        {isAdmin && (
                            <button
                                className='toolbar-btn toolbar-btn-secondary toolbar-btn-backend'
                                onClick={() => setShowConfigEditor(true)}
                                title='백엔드 설정'
                            >
                                <span className='toolbar-btn-icon'>⚙</span>
                            </button>
                        )}
                        <button
                            className='toolbar-btn toolbar-btn-primary'
                            onClick={() => setShowAddApi(true)}
                            title='API 추가'
                        >
                            <span className='toolbar-btn-icon'>＋</span>
                        </button>

                        {isAdmin && (
                            <button
                                className='toolbar-btn toolbar-btn-secondary'
                                onClick={() => setShowSqlEditor(true)}
                                title='API SQL 편집'
                            >
                                <span className='toolbar-btn-icon'>⌘</span>
                            </button>
                        )}

                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={() => refetchAll()}
                            title='전체 새로고침'
                        >
                            <span className='toolbar-btn-icon'>⟳</span>
                        </button>

                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={() => navigate("/logs")}
                            title='서버 로그 조회'
                        >
                            <span className='toolbar-btn-icon'>📋</span>
                        </button>
                    </div>
                </div>
            </header>

            {showAddApi && (
                <div
                    className='modal-overlay'
                >
                    <div
                        className='modal-content'
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className='modal-header'>
                            <h3>API 엔드포인트 추가</h3>
                            <button
                                className='close-btn'
                                onClick={() => setShowAddApi(false)}
                            >
                                ✕
                            </button>
                        </div>

                        <div className='modal-body'>
                            <div className='form-group'>
                                <label htmlFor='api-title'>제목</label>
                                <input
                                    id='api-title'
                                    type='text'
                                    placeholder='예: CoinTrader Status'
                                    value={newApiForm.title}
                                    onChange={(event) =>
                                        setNewApiForm({
                                            ...newApiForm,
                                            title: event.target.value,
                                        })
                                    }
                                />
                            </div>

                            {newApiForm.type === WIDGET_TYPE_STATUS_LIST ? (
                                <div className='form-group'>
                                    <label htmlFor='api-endpoints-text'>
                                        엔드포인트 목록
                                    </label>
                                    <textarea
                                        id='api-endpoints-text'
                                        className='config-json-textarea'
                                        placeholder={
                                            "한 줄에 하나씩 입력하세요.\nlabel | https://example.com/health"
                                        }
                                        value={newApiForm.endpointsText}
                                        onChange={(event) =>
                                            setNewApiForm({
                                                ...newApiForm,
                                                endpointsText:
                                                    event.target.value,
                                            })
                                        }
                                    />
                                </div>
                            ) : newApiForm.type === WIDGET_TYPE_NETWORK_TEST || newApiForm.type === WIDGET_TYPE_SERVER_RESOURCE ? (
                                <div className='form-group'>
                                    <label htmlFor='api-endpoint'>
                                        엔드포인트 URL
                                    </label>
                                    <input
                                        id='api-endpoint'
                                        type='text'
                                        value={newApiForm.type === WIDGET_TYPE_NETWORK_TEST ? '/dashboard/network-test' : '/dashboard/server-resources'}
                                        disabled
                                        className='input-disabled'
                                    />
                                    <span className='form-hint'>백엔드 고정 엔드포인트 (자동 설정)</span>
                                </div>
                            ) : (
                                <div className='form-group'>
                                    <label htmlFor='api-endpoint'>
                                        엔드포인트 URL
                                    </label>
                                    <input
                                        id='api-endpoint'
                                        type='text'
                                        placeholder='예: http://localhost:5000/api/status'
                                        value={newApiForm.endpoint}
                                        onChange={(event) =>
                                            setNewApiForm({
                                                ...newApiForm,
                                                endpoint: event.target.value,
                                            })
                                        }
                                    />
                                </div>
                            )}

                            <div className='form-group'>
                                <label htmlFor='api-widget-type'>
                                    위젯 타입
                                </label>
                                <select
                                    id='api-widget-type'
                                    value={newApiForm.type}
                                    onChange={(event) =>
                                        setNewApiForm({
                                            ...newApiForm,
                                            type: event.target.value,
                                        })
                                    }
                                >
                                    <option value={WIDGET_TYPE_TABLE}>
                                        데이터 테이블
                                    </option>
                                    <option value={WIDGET_TYPE_HEALTH_CHECK}>
                                        웹서버 상태 체크 (HTTP 200)
                                    </option>
                                    <option value={WIDGET_TYPE_LINE_CHART}>
                                        시간대별 추이 (라인차트)
                                    </option>
                                    <option value={WIDGET_TYPE_BAR_CHART}>
                                        기준별 수량 (바차트)
                                    </option>
                                    <option value={WIDGET_TYPE_STATUS_LIST}>
                                        API 상태 리스트 (다중 200 체크)
                                    </option>
                                    <option value={WIDGET_TYPE_NETWORK_TEST}>
                                        네트워크 테스트 (Ping/Telnet)
                                    </option>
                                    <option value={WIDGET_TYPE_SERVER_RESOURCE}>
                                        서버 리소스 모니터링 (CPU/Memory/Disk)
                                    </option>
                                </select>
                            </div>
                        </div>

                        <div className='modal-footer'>
                            <button
                                className='secondary-btn'
                                onClick={() => setShowAddApi(false)}
                            >
                                취소
                            </button>
                            <button
                                className='primary-btn'
                                onClick={handleAddApi}
                            >
                                추가
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showDashboardSettings && (
                <div
                    className='modal-overlay'
                >
                    <div
                        className='modal-content dashboard-settings-modal'
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className='modal-header'>
                            <h3>대시보드 설정</h3>
                            <button
                                className='close-btn'
                                onClick={() => setShowDashboardSettings(false)}
                            >
                                ✕
                            </button>
                        </div>

                        <div className='modal-body'>
                            {/* ── Row 1: API URL + Font size ─────────────────── */}
                            <div className='settings-row-2col'>
                                <div className='form-group'>
                                    <label htmlFor='api-base-url'>API 서버 URL</label>
                                    <div className='inline-input-group'>
                                        <input
                                            id='api-base-url'
                                            type='text'
                                            value={apiBaseUrlDraft}
                                            onChange={(e) => {
                                                setApiBaseUrlDraft(e.target.value);
                                                setApiBaseUrlSaved(false);
                                            }}
                                            placeholder='http://127.0.0.1:5000'
                                            style={{ flex: 1 }}
                                        />
                                        <button
                                            className='secondary-btn'
                                            onClick={handleApplyApiBaseUrl}
                                            title='적용 시 페이지 새로고침'
                                        >
                                            {apiBaseUrlSaved ? "✓" : "적용"}
                                        </button>
                                    </div>
                                </div>

                                <div className='form-group'>
                                    <label htmlFor='widget-font-size'>폰트 크기 (px)</label>
                                    <div className='inline-input-group'>
                                        <input
                                            id='widget-font-size'
                                            type='number'
                                            min='10'
                                            max='18'
                                            value={fontSizeDraft}
                                            onChange={(event) =>
                                                setFontSizeDraft(event.target.value)
                                            }
                                            style={{ width: '64px' }}
                                        />
                                        <button
                                            className='secondary-btn'
                                            onClick={handleApplyDashboardSettings}
                                        >
                                            적용
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* ── Row 2: Zoom ────────────────────────────────── */}
                            <div className='form-group'>
                                <label>위젯 영역 확대/축소 ({zoomDraft}%)</label>
                                <div className='zoom-control-row'>
                                    <button
                                        className='toolbar-btn'
                                        title='축소'
                                        onClick={() =>
                                            setZoomDraft((prev) =>
                                                Math.max(MIN_CONTENT_ZOOM, Number(prev) - ZOOM_STEP),
                                            )
                                        }
                                    >−</button>
                                    <input
                                        id='content-zoom'
                                        type='range'
                                        min={MIN_CONTENT_ZOOM}
                                        max={MAX_CONTENT_ZOOM}
                                        step={ZOOM_STEP}
                                        value={zoomDraft}
                                        onChange={(event) => setZoomDraft(Number(event.target.value))}
                                        className='zoom-range-input'
                                    />
                                    <button
                                        className='toolbar-btn'
                                        title='확대'
                                        onClick={() =>
                                            setZoomDraft((prev) =>
                                                Math.min(MAX_CONTENT_ZOOM, Number(prev) + ZOOM_STEP),
                                            )
                                        }
                                    >+</button>
                                    <button
                                        className='secondary-btn'
                                        onClick={handleApplyDashboardSettings}
                                    >적용</button>
                                    <button
                                        className='toolbar-btn'
                                        title='초기화'
                                        onClick={() => setZoomDraft(DEFAULT_CONTENT_ZOOM)}
                                    >↺</button>
                                </div>
                                {zoomDraft !== 100 && (
                                    <span className='zoom-warning'>위젯 영역이 100%가 아닐 때 각 위젯의 버튼은 비활성화됩니다.</span>
                                )}
                            </div>

                            {/* ── Row 3: Alarm sound buttons (all in one line) ─ */}
                            <div className='form-group'>
                                <label>알람 경고음</label>
                                <div className='alarm-sound-row'>
                                    {SOUND_TYPES.map((type) => (
                                        <button
                                            key={type}
                                            className={`alarm-sound-btn${alarmSound === type && soundEnabled ? ' active' : ''}`}
                                            onClick={() => {
                                                setAlarmSound(type);
                                                setSoundEnabled(true);
                                            }}
                                        >
                                            {type === 'beep' ? '♩ Beep' : type === 'siren' ? '⚡ Siren' : '⊛ Pulse'}
                                        </button>
                                    ))}
                                    <button
                                        className={`alarm-sound-btn${!soundEnabled ? ' active muted' : ''}`}
                                        onClick={() => setSoundEnabled(false)}
                                    >
                                        ⊘ Mute
                                    </button>
                                </div>
                            </div>

                            <div className='form-group'>
                                <label htmlFor='config-file-upload'>
                                    설정 JSON 파일 로드
                                </label>
                                <input
                                    id='config-file-upload'
                                    type='file'
                                    accept='application/json,.json'
                                    onChange={handleConfigFileChange}
                                />
                            </div>

                            <div className='form-group'>
                                <label htmlFor='config-json-text'>
                                    설정 JSON 편집/붙여넣기
                                </label>
                                <textarea
                                    id='config-json-text'
                                    className='config-json-textarea'
                                    value={configJsonDraft}
                                    onChange={(event) =>
                                        setConfigJsonDraft(event.target.value)
                                    }
                                    placeholder='설정 JSON을 붙여넣거나 파일 로드 후 편집하세요.'
                                />
                                {configErrorMessage && (
                                    <p className='config-error-text'>
                                        {configErrorMessage}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className='modal-footer'>
                            <button
                                className='secondary-btn'
                                onClick={handleExportConfig}
                            >
                                JSON 저장
                            </button>
                            <button
                                className='primary-btn'
                                onClick={handleImportConfigFromText}
                                disabled={!configJsonDraft.trim()}
                            >
                                JSON 로드
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showSqlEditor && isAdmin && (
                <SqlEditorModal
                    open={showSqlEditor}
                    onClose={() => setShowSqlEditor(false)}
                />
            )}

            {showConfigEditor && isAdmin && (
                <ConfigEditorModal
                    open={showConfigEditor}
                    onClose={() => setShowConfigEditor(false)}
                />
            )}

            <div className='dashboard-content-wrapper'>
                <div
                    className={`dashboard-content${(dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM) !== 100 ? " zoom-scaled" : ""}`}
                    style={(() => {
                        const s = (dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM) / 100;
                        return s !== 1
                            ? { transform: `scale(${s})`, transformOrigin: "top left", width: `${100 / s}%` }
                            : undefined;
                    })()}
                >
                    {dashboardWidgets.length === 0 ? (
                        <div className='empty-state'>
                            <div className='empty-icon'>📭</div>
                            <h2>API 엔드포인트를 추가하세요</h2>
                            <p>
                                모니터링할 REST API 엔드포인트를 추가하여
                                대시보드를 시작합니다.
                            </p>
                            <button
                                className='primary-btn'
                                onClick={() => setShowAddApi(true)}
                            >
                                API 추가
                            </button>
                        </div>
                    ) : (
                        <ResponsiveGridLayout
                            className='api-grid'
                            layouts={{
                                lg: gridLayout,
                                md: gridLayout,
                                sm: gridLayout,
                                xs: gridLayout,
                                xxs: gridLayout,
                            }}
                            breakpoints={{
                                lg: 1200,
                                md: 996,
                                sm: 768,
                                xs: 480,
                                xxs: 0,
                            }}
                            cols={{
                                lg: GRID_COLUMNS,
                                md: 10,
                                sm: 6,
                                xs: 4,
                                xxs: 2,
                            }}
                            rowHeight={56}
                            margin={[20, 20]}
                            containerPadding={[0, 0]}
                            draggableHandle='.api-card-header'
                            resizeHandles={["se"]}
                            transformScale={(dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM) / 100}
                            onDragStop={handleLayoutCommit}
                            onResizeStop={handleLayoutCommit}
                        >
                            {dashboardWidgets.map((widget) => {
                                const widgetType =
                                    widget.type === WIDGET_TYPE_HEALTH_CHECK
                                        ? WIDGET_TYPE_HEALTH_CHECK
                                        : widget.type === WIDGET_TYPE_STATUS_LIST
                                          ? WIDGET_TYPE_STATUS_LIST
                                          : widget.type === WIDGET_TYPE_LINE_CHART
                                            ? WIDGET_TYPE_LINE_CHART
                                            : widget.type === WIDGET_TYPE_BAR_CHART
                                              ? WIDGET_TYPE_BAR_CHART
                                              : widget.type === WIDGET_TYPE_NETWORK_TEST
                                                ? WIDGET_TYPE_NETWORK_TEST
                                                : widget.type === WIDGET_TYPE_SERVER_RESOURCE
                                                  ? WIDGET_TYPE_SERVER_RESOURCE
                                                  : WIDGET_TYPE_TABLE;
                                const apiData = getApiData(widget.id);
                                const apiResult = getApiResult(widget.id);
                                const apiError = apiResult?.error;
                                const apiStatus =
                                    apiResult?.status ?? "loading";

                                const widgetError =
                                    apiStatus === "dead" ||
                                    apiStatus === "error"
                                        ? apiError
                                        : null;
                                const isLoading =
                                    !!loadingMap[widget.id] && !apiData;
                                const isRefreshing = !!refreshingMap[widget.id];
                                const currentLayout =
                                    layouts[widget.id] ??
                                    gridLayout.find(
                                        (item) => item.i === widget.id,
                                    );

                                return (
                                    <div key={widget.id} className='grid-item'>
                                        {widgetType ===
                                        WIDGET_TYPE_LINE_CHART ? (
                                            <LineChartCard
                                                apiId={widget.id}
                                                title={widget.title}
                                                endpoint={widget.endpoint}
                                                data={apiData}
                                                loading={isLoading}
                                                error={widgetError}
                                                apiStatus={apiStatus}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    handleManualRefresh(widget)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    DEFAULT_REFRESH_INTERVAL_SEC
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                                chartSettings={
                                                    widget.chartSettings
                                                }
                                                onChartSettingsChange={(
                                                    nextSettings,
                                                ) =>
                                                    handleChartSettingsChange(
                                                        widget.id,
                                                        nextSettings,
                                                    )
                                                }
                                            />
                                        ) : widgetType ===
                                          WIDGET_TYPE_BAR_CHART ? (
                                            <BarChartCard
                                                apiId={widget.id}
                                                title={widget.title}
                                                endpoint={widget.endpoint}
                                                data={apiData}
                                                loading={isLoading}
                                                error={widgetError}
                                                apiStatus={apiStatus}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    handleManualRefresh(widget)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    DEFAULT_REFRESH_INTERVAL_SEC
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                                chartSettings={
                                                    widget.chartSettings
                                                }
                                                onChartSettingsChange={(
                                                    nextSettings,
                                                ) =>
                                                    handleChartSettingsChange(
                                                        widget.id,
                                                        nextSettings,
                                                    )
                                                }
                                            />
                                        ) : widgetType ===
                                          WIDGET_TYPE_STATUS_LIST ? (
                                            <StatusListCard
                                                title={widget.title}
                                                endpoints={widget.endpoints}
                                                data={apiData}
                                                loading={isLoading}
                                                error={widgetError}
                                                apiStatus={apiStatus}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    handleManualRefresh(widget)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    DEFAULT_REFRESH_INTERVAL_SEC
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                onEndpointsChange={(
                                                    nextEndpoints,
                                                ) =>
                                                    handleStatusListEndpointsChange(
                                                        widget.id,
                                                        nextEndpoints,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                            />
                                        ) : widgetType ===
                                          WIDGET_TYPE_SERVER_RESOURCE ? (
                                            <ServerResourceCard
                                                title={widget.title}
                                                widgetConfig={widget.serverConfig}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    refetchOne(widget.id)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    30
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                onWidgetConfigChange={(cfg) =>
                                                    updateWidget(widget.id, {
                                                        serverConfig: cfg,
                                                    })
                                                }
                                                onAlarmChange={(status) =>
                                                    reportWidgetStatus(
                                                        widget.id,
                                                        status,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                            />
                                        ) : widgetType ===
                                          WIDGET_TYPE_NETWORK_TEST ? (
                                            <NetworkTestCard
                                                title={widget.title}
                                                networkConfig={
                                                    widget.networkConfig
                                                }
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    10
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                onWidgetConfigChange={(cfg) =>
                                                    updateWidget(widget.id, {
                                                        networkConfig: cfg,
                                                    })
                                                }
                                                onAlarmChange={(status) =>
                                                    reportWidgetStatus(
                                                        widget.id,
                                                        status,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                            />
                                        ) : widgetType ===
                                          WIDGET_TYPE_HEALTH_CHECK ? (
                                            <HealthCheckCard
                                                apiId={widget.id}
                                                title={widget.title}
                                                endpoint={widget.endpoint}
                                                healthData={apiData}
                                                loading={isLoading}
                                                refreshing={isRefreshing}
                                                error={widgetError}
                                                apiStatus={apiStatus}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    handleManualRefresh(widget)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    DEFAULT_REFRESH_INTERVAL_SEC
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                            />
                                        ) : (
                                            <ApiCard
                                                apiId={widget.id}
                                                title={widget.title}
                                                endpoint={widget.endpoint}
                                                data={apiData}
                                                loading={isLoading}
                                                refreshing={isRefreshing}
                                                error={widgetError}
                                                apiStatus={apiStatus}
                                                onRemove={() =>
                                                    handleRemoveApi(widget.id)
                                                }
                                                onRefresh={() =>
                                                    handleManualRefresh(widget)
                                                }
                                                currentSize={currentLayout}
                                                sizeBounds={{
                                                    minW:
                                                        currentLayout?.minW ??
                                                        MIN_WIDGET_W,
                                                    maxW: MAX_WIDGET_W,
                                                    minH:
                                                        currentLayout?.minH ??
                                                        MIN_WIDGET_H,
                                                    maxH: MAX_WIDGET_H,
                                                }}
                                                refreshIntervalSec={
                                                    widget.refreshIntervalSec ??
                                                    DEFAULT_REFRESH_INTERVAL_SEC
                                                }
                                                onRefreshIntervalChange={(
                                                    intervalSec,
                                                ) =>
                                                    handleRefreshIntervalChange(
                                                        widget.id,
                                                        intervalSec,
                                                    )
                                                }
                                                onWidgetMetaChange={(updates) =>
                                                    handleWidgetMetaChange(
                                                        widget.id,
                                                        updates,
                                                    )
                                                }
                                                tableSettings={
                                                    widget.tableSettings
                                                }
                                                widgetFontSize={
                                                    dashboardSettings?.widgetFontSize ??
                                                    DEFAULT_WIDGET_FONT_SIZE
                                                }
                                                onTableSettingsChange={(
                                                    nextSettings,
                                                ) =>
                                                    handleTableSettingsChange(
                                                        widget.id,
                                                        nextSettings,
                                                    )
                                                }
                                                onSizeChange={(
                                                    nextWidth,
                                                    nextHeight,
                                                ) =>
                                                    handleWidgetSizeChange(
                                                        widget.id,
                                                        nextWidth,
                                                        nextHeight,
                                                    )
                                                }
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </ResponsiveGridLayout>
                    )}
                </div>
            </div>

            <AlarmBanner />

            <footer className='dashboard-footer'>
                <span className='footer-copyright'>
                    © 2026 Monitoring Dashboard. All rights reserved.
                </span>
                <span className='footer-version'>
                    monitoring-fe v{import.meta.env.VITE_APP_VERSION || "0.0.0"}
                    {backendVersion && ` | monitoring-be v${backendVersion}`}
                </span>
            </footer>
        </div>
    );
};

export default DashboardPage;
