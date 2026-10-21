'use strict';

// The Grok usage page is the ledger for Cursor included calls. Its session has
// to live in this Electron partition: Edge's cookies are app-bound, and the
// Grok CLI token cannot call the dashboard. After a login in this window, the
// same session fetches query-billing-items and writes normalized rows for the
// collector. Emails and account ids are not stored.

const fs = require('node:fs');
const path = require('node:path');
const { newestCursorUsageEventMs } = require('../shared/providers/cursor/usageEvents');
const {
  BILLING_ITEMS_URL,
  billingRowKey,
  nextPageToken,
  rowsFromBillingPayload
} = require('../shared/providers/cursor/billingItems');

const PARTITION = 'persist:grok-dashboard';
const USAGE_PAGE = 'https://grok.com/dashboard/usage';
const PAGE_SIZE = 100;
const MAX_PAGES = 40;
const STARTUP_RETRY_DELAYS_MS = [3000, 10000, 30000];
const TODAY_REFRESH_MS = 30000;
const HISTORY_REFRESH_MS = 10 * 60 * 1000;

let loginWindow = null;
const refreshes = new Map();

function billingItemsPath(userDataPath) {
  return path.join(userDataPath, 'cursor-billing-items.json');
}

function dashboardSession(session) {
  return session.fromPartition(PARTITION);
}

function writeRows(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // The API query is a rolling window. Preserve older downloaded billing rows
  // in this ledger so they do not disappear from Month/Total and History.
  let previous = [];
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(stored.rows)) previous = stored.rows;
  } catch (_) {}
  const merged = new Map(previous.map(row => [billingRowKey(row), row]));
  let changed = false;
  for (const row of rows) {
    const key = billingRowKey(row);
    if (JSON.stringify(merged.get(key)) !== JSON.stringify(row)) changed = true;
    merged.set(key, row);
  }
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), rows: [...merged.values()] }));
  fs.renameSync(temporary, filePath);
  return changed;
}

function dashboardFetch(webContents) {
  return async url => {
    const pageUrl = webContents && !webContents.isDestroyed() ? new URL(webContents.getURL() || 'about:blank') : null;
    if (pageUrl?.origin !== 'https://grok.com' || pageUrl.pathname !== '/dashboard/usage') {
      throw new Error('Open the Grok usage page and finish signing in before syncing billing items');
    }
    const requestUrl = new URL(url);
    if (requestUrl.origin !== 'https://grok.com' || requestUrl.pathname !== new URL(BILLING_ITEMS_URL).pathname) {
      throw new Error('Unsupported Grok billing URL');
    }
    // session.fetch does not share the renderer's Cloudflare validation context.
    // Keep this same-origin request in the actual logged-in dashboard document.
    // No credentials or arbitrary caller-provided script leave that document.
    const result = await webContents.executeJavaScript(`(async () => {
      if (location.origin !== 'https://grok.com' || location.pathname !== '/dashboard/usage') {
        throw new Error('Grok usage page is not ready');
      }
      const response = await fetch(${JSON.stringify(requestUrl.toString())}, {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      return { ok: response.ok, status: response.status,
        payload: response.ok ? await response.json() : null };
    })()`);
    return { ok: result.ok, status: result.status, json: async () => result.payload };
  };
}

async function fetchBillingItems(ses, { startTime, endTime, fetchImpl } = {}) {
  const fetch = fetchImpl || ses.fetch.bind(ses);
  const rows = [];
  const seen = new Set();
  const seenPages = new Set();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(BILLING_ITEMS_URL);
    url.searchParams.set('scope', 'user');
    url.searchParams.set('startTime', startTime);
    url.searchParams.set('endTime', endTime);
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageToken) url.searchParams.set('cursor', pageToken);
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      const error = new Error(`Grok billing items HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    const batch = rowsFromBillingPayload(payload);
    const token = nextPageToken(payload);
    for (const row of batch) {
      const key = billingRowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (!token) break;
    if (seenPages.has(token) || page === MAX_PAGES - 1) {
      throw new Error('Grok billing pagination did not finish; keeping the previous ledger');
    }
    seenPages.add(token);
    pageToken = token;
  }
  return rows;
}

function refreshGrokBillingItems(options = {}) {
  const filePath = billingItemsPath(options.userDataPath);
  if (!refreshes.has(filePath)) {
    const pending = downloadBillingItems(options).finally(() => refreshes.delete(filePath));
    refreshes.set(filePath, pending);
  }
  return refreshes.get(filePath).then(async ({ count, changed }) => {
    if (changed) await options.onChanged?.();
    return count;
  });
}

async function downloadBillingItems({ session, userDataPath, now = new Date(), todayOnly = false, logger, fetchImpl, webContents, homeDir } = {}) {
  const ses = dashboardSession(session);
  const end = new Date(now);
  const start = new Date(now);
  if (todayOnly) {
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  } else {
    end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCHours(0, 0, 0, 0);
    start.setTime(end.getTime());
    start.setUTCDate(start.getUTCDate() - 21);
    const nativeThrough = newestCursorUsageEventMs({ homeDir });
    if (nativeThrough > start.getTime() && nativeThrough < end.getTime()) start.setTime(nativeThrough);
  }
  const rows = await fetchBillingItems(ses, {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    fetchImpl: fetchImpl || dashboardFetch(webContents || loginWindow?.webContents)
  });
  const changed = writeRows(billingItemsPath(userDataPath), rows);
  if (typeof logger === 'function') logger(`grok billing items stored ${rows.length} cursor rows`);
  return { count: rows.length, changed };
}

function startGrokBillingRefresh({ isEnabled = () => true, onRefresh, ...options }) {
  let lastHistoryRefresh = Date.now();
  let refreshing = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped || refreshing || !isEnabled()) return;
    refreshing = true;
    const todayOnly = Date.now() - lastHistoryRefresh < HISTORY_REFRESH_MS;
    try {
      await refreshGrokBillingItems({
        ...options,
        todayOnly,
        onChanged: () => {
          if (!stopped && isEnabled()) return onRefresh?.();
        }
      });
      if (!todayOnly) lastHistoryRefresh = Date.now();
    } catch (error) {
      if (error?.status !== 401 && error?.status !== 403) options.logger?.(error.message);
    } finally {
      refreshing = false;
    }
  }, TODAY_REFRESH_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function openGrokDashboardWindow({ BrowserWindow, session, userDataPath, logger, onRefresh }) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return loginWindow;
  }
  const ses = dashboardSession(session);
  loginWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Grok usage',
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  const window = loginWindow;
  let refreshing = false;
  let retryTimer = null;
  let retryAttempt = 0;
  const refresh = () => {
    if (refreshing || window.isDestroyed()) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    refreshing = true;
    refreshGrokBillingItems({ session, userDataPath, logger, webContents: window.webContents }).then(async (count) => {
      if (count > 0 && !window.isDestroyed()) window.hide();
      await onRefresh?.(count);
      retryAttempt = 0;
    }).catch((error) => {
      if (typeof logger === 'function') logger(`grok billing items unavailable: ${error.message}`);
      // did-finish-load can precede the dashboard's authentication bootstrap.
      // Retry promptly once the document has established its login context.
      const delay = STARTUP_RETRY_DELAYS_MS[retryAttempt++];
      if (delay !== undefined && !window.isDestroyed()) {
        retryTimer = setTimeout(refresh, delay);
        retryTimer.unref?.();
      }
    }).finally(() => {
      refreshing = false;
    });
  };
  const refreshPage = () => { retryAttempt = 0; refresh(); };
  window.webContents.on('did-finish-load', refreshPage);
  window.webContents.on('did-navigate-in-page', refreshPage);
  window.on('closed', () => {
    clearTimeout(retryTimer);
    if (loginWindow === window) loginWindow = null;
  });
  window.loadURL(USAGE_PAGE);
  return window;
}

module.exports = {
  PARTITION,
  billingItemsPath,
  fetchBillingItems,
  openGrokDashboardWindow,
  refreshGrokBillingItems,
  startGrokBillingRefresh
};
