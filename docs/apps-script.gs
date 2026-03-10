const SPREADSHEET_ID = getSpreadsheetId();
const USERS_SHEET = 'Users';
const PENDING_USERS_SHEET = 'PendingUsers';
const SNAPSHOTS_SHEET = 'Snapshots';
const ADMIN_SESSIONS_SHEET = 'AdminSessions';
const ADMIN_CONFIG_SHEET = 'AdminConfig';

function doGet(e) {
  const mode = String(e.parameter.mode || '').trim();

  if (mode === 'pull') return jsonResponse(handlePull(e));

  return jsonResponse({ ok: false, message: 'Unsupported GET mode' });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return jsonResponse({ ok: false, message: 'Invalid JSON body' });
  }

  const mode = String(body.mode || '').trim();

  if (mode === 'login') return jsonResponse(handleLogin(body));
  if (mode === 'register_user') return jsonResponse(handleRegisterUser(body));
  if (mode === 'list_pending') return jsonResponse(handleListPending(body));
  if (mode === 'approve_user') return jsonResponse(handleApproveUser(body));
  if (mode === 'reject_user') return jsonResponse(handleRejectUser(body));
  if (mode === 'list_users') return jsonResponse(handleListUsers(body));
  if (mode === 'update_user') return jsonResponse(handleUpdateUser(body));
  if (mode === 'get_admin_config') return jsonResponse(handleGetAdminConfig(body));
  if (mode === 'set_admin_config') return jsonResponse(handleSetAdminConfig(body));
  if (mode === 'trim_snapshots') return jsonResponse(handleTrimSnapshots(body));
  if (mode === 'push') return jsonResponse(handlePush(body));
  if (mode === 'live_prices') return jsonResponse(handleLivePrices(body));
  if (mode === 'price_history') return jsonResponse(handlePriceHistory(body));

  return jsonResponse({ ok: false, message: 'Unsupported POST mode' });
}

function handleLivePrices(body) {
  const raw = body.tickers;
  const tickers = Array.isArray(raw)
    ? raw
    : String(raw || '')
      .split(',')
      .map((v) => String(v || '').trim())
      .filter((v) => !!v);

  if (!tickers.length) {
    return { ok: false, message: 'tickers required' };
  }

  const prices = {};
  const failedTickers = [];
  const failureReasons = {};
  const fetchedAt = nowIso();

  for (let i = 0; i < tickers.length; i += 1) {
    const ticker = String(tickers[i] || '').trim().toUpperCase();
    if (!ticker) continue;

    try {
      const yahooSymbol = toYahooSymbol(ticker);
      if (!yahooSymbol) {
        failedTickers.push(ticker);
        failureReasons[ticker] = 'invalid_ticker';
        continue;
      }

      let quoteReason = '';
      let chartReason = '';
      let price = 0;
      let previousClose = 0;

      try {
        const quote = fetchYahooQuote(yahooSymbol);
        price = Number(quote.price || 0);
        previousClose = Number(quote.previousClose || 0);
      } catch (quoteErr) {
        quoteReason = normalizeLivePriceError(String((quoteErr && quoteErr.message) || quoteErr || 'unknown'));
      }

      if (!(price > 0)) {
        try {
          const chart = fetchYahooChart(yahooSymbol);
          price = Number(chart.price || 0);
          if (!(previousClose > 0)) previousClose = Number(chart.previousClose || 0);
        } catch (chartErr) {
          chartReason = normalizeLivePriceError(String((chartErr && chartErr.message) || chartErr || 'unknown'));
        }
      }

      if (!(price > 0)) {
        failedTickers.push(ticker);
        if (quoteReason && chartReason) {
          failureReasons[ticker] = quoteReason + '_and_' + chartReason;
        } else if (chartReason) {
          failureReasons[ticker] = chartReason;
        } else if (quoteReason) {
          failureReasons[ticker] = quoteReason;
        } else {
          failureReasons[ticker] = 'invalid_price_from_quote_and_chart';
        }
        continue;
      }

      prices[ticker] = {
        ticker: ticker,
        price: price,
        previousClose: previousClose > 0 ? previousClose : '',
        changePct: previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : '',
        fetchedAt: fetchedAt
      };
    } catch (err) {
      failedTickers.push(ticker);
      const rawMessage = String((err && err.message) || err || 'unknown');
      failureReasons[ticker] = normalizeLivePriceError(rawMessage);
    }
  }

  if (
    failedTickers.length &&
    failedTickers.every((ticker) => String(failureReasons[ticker] || '') === 'missing_external_request_permission')
  ) {
    return {
      ok: false,
      message: 'Apps Script is missing external request permission. Run authorizeExternalRequest() once in script editor, then redeploy Web App as Execute as: Me.'
    };
  }

  return {
    ok: true,
    data: {
      prices: prices,
      success: Object.keys(prices).length,
      failedTickers: failedTickers,
      failureReasons: failureReasons
    }
  };
}

function handlePriceHistory(body) {
  const ticker = String(body.ticker || '').trim().toUpperCase();
  const days = Math.max(1, Math.min(365, Number(body.days || 7)));
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!ticker) return { ok: false, message: 'ticker required' };

  const yahooSymbol = toYahooSymbol(ticker);
  if (!yahooSymbol) return { ok: false, message: 'invalid ticker' };

  try {
    const chart = fetchYahooChart(yahooSymbol, '1y');
    let points = Array.isArray(chart.points) ? chart.points : [];

    if (from && to && isValidIsoDate(from) && isValidIsoDate(to)) {
      const fromTs = new Date(from).getTime();
      const toTs = new Date(to).getTime();
      points = points.filter((p) => {
        const ts = new Date(String(p.date || '')).getTime();
        return ts >= fromTs && ts <= toTs;
      });
    } else {
      points = points.slice(-days);
    }
    if (!points.length) {
      return { ok: false, message: 'No trading-day history found' };
    }
    return {
      ok: true,
      data: {
        ticker: ticker,
        points: points,
        latest: Number(points[points.length - 1].close || 0)
      }
    };
  } catch (err) {
    return { ok: false, message: normalizeLivePriceError(String((err && err.message) || err || 'unknown')) };
  }
}

function isValidIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw.match(/^\d{4}-\d{2}-\d{2}$/)) return false;
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return false;
  return dt.toISOString().slice(0, 10) === raw;
}

function fetchYahooQuote(yahooSymbol) {
  const url =
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
    encodeURIComponent(yahooSymbol);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('quote_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result =
    payload &&
    payload.quoteResponse &&
    payload.quoteResponse.result &&
    payload.quoteResponse.result[0];

  return {
    price: Number(result && result.regularMarketPrice ? result.regularMarketPrice : 0),
    previousClose: Number(result && result.regularMarketPreviousClose ? result.regularMarketPreviousClose : 0)
  };
}

function fetchYahooChart(yahooSymbol, rangeInput) {
  const range = String(rangeInput || '5d').trim() || '5d';
  const url =
    'https://query2.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSymbol) +
    '?interval=1d&range=' + encodeURIComponent(range);

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Accept: 'application/json,text/plain,*/*'
    }
  });

  const code = Number(res.getResponseCode() || 0);
  if (code < 200 || code >= 300) {
    throw new Error('chart_http_' + code);
  }

  const payload = JSON.parse(res.getContentText() || '{}');
  const result = payload && payload.chart && payload.chart.result && payload.chart.result[0];
  if (!result) return { price: 0, previousClose: 0 };

  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = (
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0] &&
    result.indicators.quote[0].close
  ) || [];

  let latestClose = 0;
  for (let j = closes.length - 1; j >= 0; j -= 1) {
    const n = Number(closes[j] || 0);
    if (n > 0) {
      latestClose = n;
      break;
    }
  }

  const points = [];
  for (let i = 0; i < closes.length; i += 1) {
    const close = Number(closes[i] || 0);
    const ts = Number(timestamps[i] || 0);
    if (!(close > 0) || !(ts > 0)) continue;
    points.push({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      close: close
    });
  }

  return {
    price: Number(meta.regularMarketPrice || latestClose || 0),
    previousClose: Number(meta.previousClose || meta.chartPreviousClose || 0),
    points: points
  };
}

function toYahooSymbol(ticker) {
  const text = String(ticker || '').trim().toUpperCase();
  if (!text) return '';
  if (text.indexOf(':') >= 0) {
    const parts = text.split(':');
    const ex = String(parts[0] || '').trim();
    const sym = String(parts[1] || '').trim();
    if (!sym) return '';
    if (ex === 'NSE') return sym + '.NS';
    return sym;
  }
  if (text.indexOf('.') >= 0) return text;
  return text + '.NS';
}

function normalizeLivePriceError(message) {
  const text = String(message || '').toLowerCase();
  if (text.indexOf('script.external_request') >= 0) {
    return 'missing_external_request_permission';
  }
  if (text.indexOf('quote_http_') >= 0 || text.indexOf('chart_http_') >= 0) {
    return text.replace(/\s+/g, '_');
  }
  return 'fetch_exception';
}

function authorizeExternalRequest() {
  // Run this once from Apps Script editor to grant UrlFetchApp permission.
  const res = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=INFY.NS', {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  return 'Auth check HTTP ' + String(res.getResponseCode() || 0);
}

function handleLogin(body) {
  const loginId = String(body.loginId || '').trim().toLowerCase();
  const password = String(body.password || '').trim();

  if (!loginId || !password) {
    return { ok: false, message: 'loginId and password are required' };
  }

  const user = findActiveUserByLoginId(loginId);
  if (!user) return { ok: false, message: 'User not found or inactive' };

  if (!verifyPassword(password, user.salt, user.passwordHash)) {
    return { ok: false, message: 'Invalid credentials' };
  }

  const adminSessionToken = user.role === 'ADMIN' ? createAdminSession(user.userId) : '';

  return {
    ok: true,
    data: {
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        role: user.role,
        adminSessionToken: adminSessionToken
      }
    }
  };
}

function handleRegisterUser(body) {
  const name = String(body.name || '').trim();
  const loginId = String(body.loginId || '').trim().toLowerCase();
  const password = String(body.password || '').trim();
  const email = String(body.email || '').trim().toLowerCase();

  if (!name || !loginId || !password) {
    return { ok: false, message: 'name, loginId, password are required' };
  }

  if (findAnyUserByLoginId(loginId)) {
    return { ok: false, message: 'Login ID already exists' };
  }

  const pending = readPendingRows();
  if (pending.some((row) => row.loginId === loginId && row.status === 'PENDING')) {
    return { ok: false, message: 'Request already pending for this Login ID' };
  }

  const hashData = hashPassword(password);
  const requestId = Utilities.getUuid();

  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);

  sheet.appendRow([
    requestId,
    name,
    loginId,
    email,
    hashData.passwordHash,
    hashData.salt,
    'PENDING',
    nowIso(),
    '',
    '',
    ''
  ]);

  return {
    ok: true,
    data: {
      requestId: requestId,
      message: 'Access request submitted. Wait for admin approval.'
    }
  };
}

function handleListPending(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const rows = readPendingRows()
    .filter((row) => row.status === 'PENDING')
    .map((row) => ({
      requestId: row.requestId,
      name: row.name,
      loginId: row.loginId,
      email: row.email,
      requestedAt: row.requestedAt,
      status: row.status
    }));

  return {
    ok: true,
    data: { rows: rows }
  };
}

function handleApproveUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const role = normalizeRole(body.role);
  if (!requestId) return { ok: false, message: 'requestId required' };

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);

  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;

    const loginId = String(values[i][2] || '').trim().toLowerCase();
    if (findAnyUserByLoginId(loginId)) {
      pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['REJECTED', nowIso(), auth.adminUser.userId, 'Duplicate loginId']]);
      return { ok: false, message: 'Login ID already exists in Users' };
    }

    const userId = Utilities.getUuid();
    const usersSheet = getSheet(USERS_SHEET, [
      'userId',
      'name',
      'loginId',
      'email',
      'passwordHash',
      'salt',
      'role',
      'status',
      'createdAt',
      'approvedAt',
      'approvedBy'
    ]);

    usersSheet.appendRow([
      userId,
      String(values[i][1] || '').trim(),
      loginId,
      String(values[i][3] || '').trim().toLowerCase(),
      String(values[i][4] || '').trim(),
      String(values[i][5] || '').trim(),
      role,
      'ACTIVE',
      nowIso(),
      nowIso(),
      auth.adminUser.userId
    ]);

    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['APPROVED', nowIso(), auth.adminUser.userId, 'Approved']]);

    return { ok: true, data: { message: 'User approved' } };
  }

  return { ok: false, message: 'Pending request not found' };
}

function handleRejectUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return auth;

  const requestId = String(body.requestId || '').trim();
  const note = String(body.note || '').trim() || 'Rejected by admin';
  if (!requestId) return { ok: false, message: 'requestId required' };

  const pendingSheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);

  const values = pendingSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    const rowRequestId = String(values[i][0] || '').trim();
    const status = String(values[i][6] || '').trim().toUpperCase();
    if (rowRequestId !== requestId || status !== 'PENDING') continue;

    pendingSheet.getRange(i + 1, 7, 1, 4).setValues([['REJECTED', nowIso(), auth.adminUser.userId, note]]);
    return { ok: true, data: { message: 'User rejected' } };
  }

  return { ok: false, message: 'Pending request not found' };
}

function handlePush(body) {
  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };

  const user = findActiveUserByUserId(userId);
  if (!user) return { ok: false, message: 'User not active' };

  const payload = body.payload || {};
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  sheet.appendRow([nowIso(), userId, JSON.stringify(payload)]);
  trimSnapshotsForUser(userId);

  return { ok: true, data: { message: 'Snapshot stored' } };
}

function handlePull(e) {
  const userId = String(e.parameter.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };

  const user = findActiveUserByUserId(userId);
  if (!user) return { ok: false, message: 'User not active' };

  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();

  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i][1] || '').trim() !== userId) continue;

    try {
      const payload = JSON.parse(String(values[i][2] || '{}'));
      trimSnapshotsForUser(userId);
      return { ok: true, data: { payload: payload } };
    } catch (err) {
      return { ok: false, message: 'Stored payload is invalid JSON' };
    }
  }

  return { ok: false, message: 'No snapshot found for user' };
}

function handleListUsers(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return { ok: false, message: auth.message };

  const users = readUsers();
  const sanitized = users.map(function (row) {
    return {
      userId: row.userId,
      name: row.name,
      loginId: row.loginId,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy
    };
  });
  return { ok: true, data: { rows: sanitized } };
}

function handleUpdateUser(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return { ok: false, message: auth.message };

  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };

  const role = body.role ? normalizeRole(body.role) : null;
  const status = body.status ? String(body.status || '').trim().toUpperCase() : null;
  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== userId) continue;
    if (role) values[i][6] = role;
    if (status) values[i][7] = status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
    sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);
    return { ok: true, data: { message: 'User updated' } };
  }

  return { ok: false, message: 'User not found' };
}

function handleGetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return { ok: false, message: auth.message };
  const config = readAdminConfig();
  return { ok: true, data: { maxSnapshots: config.maxSnapshots } };
}

function handleSetAdminConfig(body) {
  const auth = assertAdmin(body.adminUserId, body.adminToken);
  if (!auth.ok) return { ok: false, message: auth.message };
  const maxSnapshots = Math.max(1, Number(body.maxSnapshots || 10));
  setAdminConfigValue('maxSnapshots', String(maxSnapshots));
  return { ok: true, data: { message: 'Admin config saved' } };
}

function handleTrimSnapshots(body) {
  const adminUserId = String(body.adminUserId || '').trim();
  const adminToken = String(body.adminToken || '').trim();
  if (adminUserId && adminToken) {
    const auth = assertAdmin(adminUserId, adminToken);
    if (!auth.ok) return { ok: false, message: auth.message };
    const deleted = trimSnapshotsForAllUsers();
    return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
  }

  const userId = String(body.userId || '').trim();
  if (!userId) return { ok: false, message: 'userId required' };
  const deleted = trimSnapshotsForUser(userId);
  return { ok: true, data: { message: 'Snapshots trimmed', deleted: deleted } };
}

function assertAdmin(adminUserIdInput, adminTokenInput) {
  const adminUserId = String(adminUserIdInput || '').trim();
  const adminToken = String(adminTokenInput || '').trim();

  if (!adminUserId || !adminToken) {
    return { ok: false, message: 'Admin session required' };
  }

  const admin = findActiveUserByUserId(adminUserId);
  if (!admin || admin.role !== 'ADMIN') {
    return { ok: false, message: 'Only admin can perform this action' };
  }

  if (!validateAdminSession(adminUserId, adminToken)) {
    return { ok: false, message: 'Invalid or expired admin session' };
  }

  return { ok: true, adminUser: admin };
}

function readUsers() {
  const sheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);
  const values = sheet.getDataRange().getValues();

  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      userId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: String(values[i][2] || '').trim().toLowerCase(),
      email: String(values[i][3] || '').trim().toLowerCase(),
      passwordHash: String(values[i][4] || '').trim(),
      salt: String(values[i][5] || '').trim(),
      role: normalizeRole(values[i][6]),
      status: String(values[i][7] || 'ACTIVE').trim().toUpperCase(),
      createdAt: String(values[i][8] || '').trim(),
      approvedAt: String(values[i][9] || '').trim(),
      approvedBy: String(values[i][10] || '').trim()
    });
  }

  return rows;
}

function readAdminConfig() {
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  let maxSnapshots = 10;
  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][0] || '').trim();
    const value = String(values[i][1] || '').trim();
    if (key === 'maxSnapshots') {
      const parsed = Number(value || 0);
      maxSnapshots = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    }
  }
  return { maxSnapshots: maxSnapshots };
}

function setAdminConfigValue(key, value) {
  const sheet = getSheet(ADMIN_CONFIG_SHEET, ['key', 'value']);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== key) continue;
    values[i][1] = String(value || '');
    sheet.getRange(i + 1, 1, 1, 2).setValues([[values[i][0], values[i][1]]]);
    return;
  }
  sheet.appendRow([key, String(value || '')]);
}

function trimSnapshotsForUser(userId) {
  const config = readAdminConfig();
  const maxSnapshots = Math.max(1, Number(config.maxSnapshots || 10));
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const rowIndexes = [];

  for (let i = 1; i < values.length; i += 1) {
    if (String(values[i][1] || '').trim() === userId) {
      rowIndexes.push(i + 1);
    }
  }

  if (rowIndexes.length <= maxSnapshots) return 0;
  const toDelete = rowIndexes.slice(0, rowIndexes.length - maxSnapshots);
  for (let i = toDelete.length - 1; i >= 0; i -= 1) {
    sheet.deleteRow(toDelete[i]);
  }
  return toDelete.length;
}

function trimSnapshotsForAllUsers() {
  const sheet = getSheet(SNAPSHOTS_SHEET, ['timestamp', 'userId', 'payloadJson']);
  const values = sheet.getDataRange().getValues();
  const userIds = {};
  for (let i = 1; i < values.length; i += 1) {
    const userId = String(values[i][1] || '').trim();
    if (userId) userIds[userId] = true;
  }
  let deleted = 0;
  for (var id in userIds) {
    deleted += trimSnapshotsForUser(id);
  }
  return deleted;
}

function readPendingRows() {
  const sheet = getSheet(PENDING_USERS_SHEET, [
    'requestId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'status',
    'requestedAt',
    'reviewedAt',
    'reviewedBy',
    'reviewNote'
  ]);
  const values = sheet.getDataRange().getValues();

  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    rows.push({
      requestId: String(values[i][0] || '').trim(),
      name: String(values[i][1] || '').trim(),
      loginId: String(values[i][2] || '').trim().toLowerCase(),
      email: String(values[i][3] || '').trim().toLowerCase(),
      passwordHash: String(values[i][4] || '').trim(),
      salt: String(values[i][5] || '').trim(),
      status: String(values[i][6] || 'PENDING').trim().toUpperCase(),
      requestedAt: String(values[i][7] || '').trim(),
      reviewedAt: String(values[i][8] || '').trim(),
      reviewedBy: String(values[i][9] || '').trim(),
      reviewNote: String(values[i][10] || '').trim()
    });
  }

  return rows;
}

function findActiveUserByLoginId(loginIdLower) {
  const users = readUsers();
  return users.find((row) => row.status === 'ACTIVE' && row.loginId === loginIdLower) || null;
}

function findAnyUserByLoginId(loginIdLower) {
  const users = readUsers();
  return users.find((row) => row.loginId === loginIdLower) || null;
}

function findActiveUserByUserId(userId) {
  const users = readUsers();
  return users.find((row) => row.status === 'ACTIVE' && row.userId === userId) || null;
}

function normalizeRole(roleValue) {
  return String(roleValue || '').trim().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER';
}

function hashPassword(password) {
  const salt = Utilities.getUuid().replaceAll('-', '');
  return {
    salt: salt,
    passwordHash: sha256Hex(salt + '|' + String(password || ''))
  };
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const computed = sha256Hex(String(salt) + '|' + String(password));
  return computed === String(expectedHash);
}

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes
    .map((b) => {
      const v = (b + 256) % 256;
      return ('0' + v.toString(16)).slice(-2);
    })
    .join('');
}

function createAdminSession(adminUserId) {
  const token = Utilities.getUuid() + Utilities.getUuid().replaceAll('-', '');
  const tokenHash = sha256Hex(token);
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  sheet.appendRow([Utilities.getUuid(), adminUserId, tokenHash, nowIso(), expiresAt, 'ACTIVE']);
  return token;
}

function validateAdminSession(adminUserId, token) {
  const tokenHash = sha256Hex(String(token || ''));
  const now = new Date().toISOString();
  const sheet = getSheet(ADMIN_SESSIONS_SHEET, ['sessionId', 'adminUserId', 'tokenHash', 'issuedAt', 'expiresAt', 'status']);
  const values = sheet.getDataRange().getValues();

  for (let i = values.length - 1; i >= 1; i -= 1) {
    const rowUserId = String(values[i][1] || '').trim();
    const rowTokenHash = String(values[i][2] || '').trim();
    const expiresAt = String(values[i][4] || '').trim();
    const status = String(values[i][5] || '').trim().toUpperCase();

    if (rowUserId !== adminUserId || rowTokenHash !== tokenHash) continue;
    if (status !== 'ACTIVE') return false;
    if (!expiresAt || expiresAt <= now) return false;
    return true;
  }

  return false;
}

function getSheet(sheetName, headers) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}

function getSpreadsheetId() {
  const prop = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (prop && String(prop).trim()) return String(prop).trim();
  throw new Error('Missing SPREADSHEET_ID in Script Properties');
}

function nowIso() {
  return new Date().toISOString();
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function createAdminDirect(name, loginId, password, email) {
  const n = String(name || '').trim();
  const l = String(loginId || '').trim().toLowerCase();
  const p = String(password || '').trim();
  const e = String(email || '').trim().toLowerCase();

  if (!n || !l || !p) {
    throw new Error('name, loginId, password are required');
  }

  if (findAnyUserByLoginId(l)) {
    throw new Error('loginId already exists');
  }

  const hashData = hashPassword(p);
  const usersSheet = getSheet(USERS_SHEET, [
    'userId',
    'name',
    'loginId',
    'email',
    'passwordHash',
    'salt',
    'role',
    'status',
    'createdAt',
    'approvedAt',
    'approvedBy'
  ]);

  usersSheet.appendRow([
    Utilities.getUuid(),
    n,
    l,
    e,
    hashData.passwordHash,
    hashData.salt,
    'ADMIN',
    'ACTIVE',
    nowIso(),
    nowIso(),
    'SELF_INIT'
  ]);
}
