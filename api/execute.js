// /api/execute — Vercel Serverless Function (Node.js runtime)
//
// Powers the Smart Compress "Code Playground" Pro Tool for every language
// that isn't executed directly in the browser (Python/Pyodide and SQL/sql.js
// run client-side and never call this endpoint — see index.html).
//
// This function is a thin, honest proxy in front of a real Judge0 CE
// instance. It never fabricates output: if the backend isn't configured, or
// the request to Judge0 fails, it returns the real error and the frontend
// shows that error verbatim. Nothing is simulated.
//
// REQUEST (POST, JSON):
// {
//   "language": "java" | "c" | "cpp" | "javascript" | "typescript" | "go" |
//               "rust" | "php" | "kotlin" | "swift" | "python",
//   "source_code": "<the code from the editor, plain text>",
//   "stdin": "<optional custom input, plain text>"
// }
//
// RESPONSE (JSON, always):
// Success: {
//   "success": true,
//   "statusId": <Judge0 numeric status id>,
//   "statusLabel": "Accepted" | "Compilation Error" | "Runtime Error" |
//                   "Time Limit Exceeded" | "Memory Limit Exceeded" | ...,
//   "stdout": "...", "stderr": "...", "compileOutput": "...",
//   "time": "0.012", "memory": 3456, "exitCode": 0,
//   "languageUsed": "Java (OpenJDK 17.0.6)"
// }
// Failure: { "success": false, "error": "exact human-readable error message" }
//
// SETUP (required — pick ONE of the two backends below):
//
//   Option A — RapidAPI Judge0 CE (easiest, has a free tier):
//     1. Subscribe at https://rapidapi.com/judge0-official/api/judge0-ce
//     2. In Vercel → Project → Settings → Environment Variables, add:
//          JUDGE0_RAPIDAPI_KEY = <your RapidAPI key>
//     3. Redeploy (adding an env var does not affect an already-live deployment).
//
//   Option B — Self-hosted / any Judge0-compatible REST API:
//     1. In Vercel → Project → Settings → Environment Variables, add:
//          JUDGE0_API_URL = https://your-judge0-host.example.com
//          JUDGE0_API_KEY = <optional, sent as X-Auth-Token if your instance requires it>
//     2. Redeploy.
//
// If neither is configured, every execution request returns a clear
// "backend not configured" error instead of a fake result.
//
// To verify the function is deployed and a backend is reachable, open in a
// browser (GET request): https://YOUR-SITE/api/execute
// It returns diagnostics (which backend is active, and the live language
// list) — never any API key value itself.

var RAPIDAPI_HOST = "judge0-ce.p.rapidapi.com";

// Per-attempt timeout for any single call to the Judge0 backend.
var REQUEST_TIMEOUT_MS = 25000;

// When Judge0 doesn't finish synchronously (wait=true), we fall back to
// polling the submission by token. Capped so the whole request comfortably
// fits inside this function's configured maxDuration (see vercel.json).
var POLL_INTERVAL_MS = 700;
var POLL_MAX_ATTEMPTS = 20; // ~14s of polling on top of the initial call

// Resource limits applied to every submission. Generous enough for normal
// learning/practice programs, tight enough to fail fast (and cheaply) on
// runaway loops or fork bombs.
var CPU_TIME_LIMIT_SECONDS = 8; // triggers "Time Limit Exceeded"
var WALL_TIME_LIMIT_SECONDS = 12;
var MEMORY_LIMIT_KB = 256000; // 250 MB — triggers "Memory Limit Exceeded"

// Judge0's own numeric status ids (fixed across all Judge0 CE instances).
var STATUS = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RUNTIME_ERROR_SIGSEGV: 7,
  RUNTIME_ERROR_SIGXFSZ: 8,
  RUNTIME_ERROR_SIGFPE: 9,
  RUNTIME_ERROR_SIGABRT: 10,
  RUNTIME_ERROR_NZEC: 11,
  RUNTIME_ERROR_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
};
var RUNTIME_ERROR_IDS = [7, 8, 9, 10, 11, 12];

// Each entry: keywords used to find the best match in Judge0's live
// /languages list (case-insensitive substring match on the language name),
// plus a hardcoded fallback id (a widely-available Judge0 CE id) used only
// if the /languages lookup itself fails, so the tool still works.
var LANGUAGE_MAP = {
  python: { keywords: ["python 3"], exclude: ["pypy"], fallbackId: 71 },
  java: { keywords: ["java (open"], exclude: [], fallbackId: 62 },
  c: { keywords: ["c (gcc"], exclude: ["c++"], fallbackId: 50 },
  cpp: { keywords: ["c++ (gcc"], exclude: [], fallbackId: 54 },
  javascript: { keywords: ["javascript (node"], exclude: [], fallbackId: 63 },
  typescript: { keywords: ["typescript ("], exclude: [], fallbackId: 74 },
  go: { keywords: ["go ("], exclude: [], fallbackId: 60 },
  rust: { keywords: ["rust ("], exclude: [], fallbackId: 73 },
  php: { keywords: ["php ("], exclude: [], fallbackId: 68 },
  kotlin: { keywords: ["kotlin ("], exclude: [], fallbackId: 78 },
  swift: { keywords: ["swift ("], exclude: [], fallbackId: 83 },
};

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[api/execute]"].concat(args));
}
function logError() {
  var args = Array.prototype.slice.call(arguments);
  console.error.apply(console, ["[api/execute]"].concat(args));
}

// ---- Backend resolution (RapidAPI vs self-hosted) --------------------------
function resolveBackend() {
  var rapidKey = process.env.JUDGE0_RAPIDAPI_KEY;
  var selfHostedUrl = process.env.JUDGE0_API_URL;
  var selfHostedKey = process.env.JUDGE0_API_KEY;

  if (selfHostedUrl) {
    return {
      kind: "self-hosted",
      baseUrl: selfHostedUrl.replace(/\/+$/, ""),
      headers: Object.assign(
        { "Content-Type": "application/json" },
        selfHostedKey ? { "X-Auth-Token": selfHostedKey } : {}
      ),
    };
  }
  if (rapidKey) {
    return {
      kind: "rapidapi",
      baseUrl: "https://" + RAPIDAPI_HOST,
      headers: {
        "Content-Type": "application/json",
        "X-RapidAPI-Key": rapidKey,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    };
  }
  return null;
}

// ---- fetch with timeout -----------------------------------------------------
async function fetchWithTimeout(url, options) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function () {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(
      url,
      Object.assign({}, options, { signal: controller.signal })
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---- Language id resolution, cached per warm lambda instance ---------------
var languageListCache = { fetchedAt: 0, list: null };
var LANGUAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getLiveLanguageList(backend) {
  var now = Date.now();
  if (
    languageListCache.list &&
    now - languageListCache.fetchedAt < LANGUAGE_CACHE_TTL_MS
  ) {
    return languageListCache.list;
  }
  var res = await fetchWithTimeout(backend.baseUrl + "/languages", {
    method: "GET",
    headers: backend.headers,
  });
  if (!res.ok) {
    throw new Error(
      "Judge0 /languages returned HTTP " + res.status + " " + res.statusText
    );
  }
  var list = await res.json();
  if (!Array.isArray(list)) throw new Error("Judge0 /languages returned an unexpected payload");
  languageListCache = { fetchedAt: now, list: list };
  return list;
}

// Picks the highest-numbered version among the entries that match the
// language's keywords, so "latest stable" tracks whatever the Judge0
// instance currently offers (rather than a hardcoded id that goes stale).
function pickBestLanguage(list, spec) {
  var candidates = list.filter(function (entry) {
    var name = (entry.name || "").toLowerCase();
    var keywordHit = spec.keywords.some(function (k) {
      return name.indexOf(k) !== -1;
    });
    var excluded = (spec.exclude || []).some(function (x) {
      return name.indexOf(x) !== -1;
    });
    return keywordHit && !excluded;
  });
  if (!candidates.length) return null;

  function versionScore(name) {
    var m = name.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return 0;
    var major = parseInt(m[1] || "0", 10);
    var minor = parseInt(m[2] || "0", 10);
    var patch = parseInt(m[3] || "0", 10);
    return major * 1e6 + minor * 1e3 + patch;
  }

  candidates.sort(function (a, b) {
    return (
      versionScore((b.name || "").toLowerCase()) -
      versionScore((a.name || "").toLowerCase())
    );
  });
  return candidates[0];
}

async function resolveLanguageId(backend, languageKey) {
  var spec = LANGUAGE_MAP[languageKey];
  if (!spec) {
    var err = new Error("Unsupported language: " + languageKey);
    err.status = 400;
    throw err;
  }
  try {
    var list = await getLiveLanguageList(backend);
    var best = pickBestLanguage(list, spec);
    if (best) return { id: best.id, name: best.name };
  } catch (lookupErr) {
    logError(
      "Language list lookup failed, falling back to hardcoded id for",
      languageKey,
      "-",
      lookupErr && lookupErr.message
    );
  }
  return { id: spec.fallbackId, name: languageKey + " (fallback id, live lookup unavailable)" };
}

// ---- base64 helpers (Judge0 requires base64 for source/stdin/output) -------
function b64encode(str) {
  return Buffer.from(str == null ? "" : String(str), "utf8").toString("base64");
}
function b64decode(str) {
  if (str == null) return "";
  try {
    return Buffer.from(str, "base64").toString("utf8");
  } catch (e) {
    return "";
  }
}

// ---- Submit + (if needed) poll ---------------------------------------------
async function submitToJudge0(backend, languageId, sourceCode, stdin) {
  var payload = {
    language_id: languageId,
    source_code: b64encode(sourceCode),
    stdin: b64encode(stdin || ""),
    cpu_time_limit: CPU_TIME_LIMIT_SECONDS,
    wall_time_limit: WALL_TIME_LIMIT_SECONDS,
    memory_limit: MEMORY_LIMIT_KB,
  };

  var submitRes = await fetchWithTimeout(
    backend.baseUrl + "/submissions?base64_encoded=true&wait=true",
    {
      method: "POST",
      headers: backend.headers,
      body: JSON.stringify(payload),
    }
  );

  var rawText = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error(
      "Judge0 submission failed (HTTP " +
        submitRes.status +
        "): " +
        rawText.slice(0, 500)
    );
  }

  var result;
  try {
    result = rawText ? JSON.parse(rawText) : {};
  } catch (e) {
    throw new Error("Judge0 returned a non-JSON response: " + rawText.slice(0, 300));
  }

  // Some Judge0 deployments ignore wait=true under load and just hand back a
  // token with status still "In Queue"/"Processing" — poll until it settles.
  var statusId = result && result.status && result.status.id;
  if (statusId === STATUS.IN_QUEUE || statusId === STATUS.PROCESSING || !statusId) {
    if (!result.token) {
      throw new Error("Judge0 did not return a submission token to poll.");
    }
    result = await pollSubmission(backend, result.token);
  }

  return result;
}

async function pollSubmission(backend, token) {
  for (var attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise(function (resolve) {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
    var res = await fetchWithTimeout(
      backend.baseUrl + "/submissions/" + token + "?base64_encoded=true",
      { method: "GET", headers: backend.headers }
    );
    if (!res.ok) continue;
    var data = await res.json();
    var statusId = data && data.status && data.status.id;
    if (statusId && statusId !== STATUS.IN_QUEUE && statusId !== STATUS.PROCESSING) {
      return data;
    }
  }
  var timeoutErr = new Error(
    "Judge0 is still processing this submission after " +
      ((POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000).toFixed(0) +
      "s. The judge may be under heavy load — click Run Again to retry."
  );
  timeoutErr.status = 504;
  throw timeoutErr;
}

// ---- Status → friendly label, with a best-effort MLE heuristic -------------
// Judge0 CE does not always expose a distinct "Memory Limit Exceeded" status
// id (behavior varies by instance/version); when it doesn't, an MLE program
// typically surfaces as a generic runtime error with memory usage at/near
// the configured limit. We relabel that specific, real case as MLE instead
// of a vague "Runtime Error" — this is an honest interpretation of Judge0's
// own numbers, not a fabricated result.
function describeStatus(result) {
  var statusId = result && result.status && result.status.id;
  var rawDesc = (result && result.status && result.status.description) || "Unknown";
  var memory = result && result.memory; // KB, or null

  if (statusId === STATUS.ACCEPTED) return { label: "Accepted", cssState: "ok" };
  if (statusId === STATUS.COMPILATION_ERROR) return { label: "Compilation Error", cssState: "error" };
  if (statusId === STATUS.TIME_LIMIT_EXCEEDED) return { label: "Time Limit Exceeded", cssState: "error" };
  if (statusId === STATUS.INTERNAL_ERROR) return { label: "Judge Internal Error", cssState: "error" };
  if (statusId === STATUS.EXEC_FORMAT_ERROR) return { label: "Exec Format Error", cssState: "error" };

  if (RUNTIME_ERROR_IDS.indexOf(statusId) !== -1) {
    var nearLimit = memory == null || memory >= MEMORY_LIMIT_KB * 0.97;
    if (nearLimit && (statusId === STATUS.RUNTIME_ERROR_SIGSEGV || statusId === STATUS.RUNTIME_ERROR_OTHER)) {
      return { label: "Memory Limit Exceeded", cssState: "error" };
    }
    return { label: "Runtime Error (" + rawDesc.replace(/^Runtime Error \(?/, "").replace(/\)$/, "") + ")", cssState: "error" };
  }

  return { label: rawDesc, cssState: "error" };
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "object") return req.body;
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString("utf8") || "{}");
    } catch (e) {
      return {};
    }
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch (e) {
      return {};
    }
  }
  return {};
}

function setCorsHeaders(req, res) {
  var origin = (req.headers && req.headers.origin) || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  var backend = resolveBackend();

  // ---- GET /api/execute: diagnostics, no key values ever returned ----
  if (req.method === "GET") {
    var diag = {
      ok: true,
      message: "api/execute is deployed and this function is executing.",
      backendConfigured: !!backend,
      backendKind: backend ? backend.kind : null,
      supportedLanguages: Object.keys(LANGUAGE_MAP),
      cpuTimeLimitSeconds: CPU_TIME_LIMIT_SECONDS,
      memoryLimitKb: MEMORY_LIMIT_KB,
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    };
    if (backend) {
      try {
        var list = await getLiveLanguageList(backend);
        diag.liveLanguageCount = list.length;
      } catch (e) {
        diag.liveLanguageLookupError = e && e.message;
      }
    }
    res.status(200).json(diag);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed. Use POST." });
    return;
  }

  if (!backend) {
    logError("No Judge0 backend configured (neither JUDGE0_API_URL nor JUDGE0_RAPIDAPI_KEY is set).");
    res.status(500).json({
      success: false,
      error:
        "Code execution backend is not configured on the server. Set either JUDGE0_API_URL " +
        "(self-hosted Judge0) or JUDGE0_RAPIDAPI_KEY (RapidAPI Judge0 CE) in Vercel → Project " +
        "Settings → Environment Variables, then redeploy.",
    });
    return;
  }

  var body;
  try {
    body = parseBody(req);
  } catch (bodyErr) {
    res.status(400).json({ success: false, error: "Malformed request body: " + (bodyErr && bodyErr.message) });
    return;
  }

  var language = typeof body.language === "string" ? body.language.toLowerCase().trim() : "";
  var sourceCode = typeof body.source_code === "string" ? body.source_code : "";
  var stdin = typeof body.stdin === "string" ? body.stdin : "";

  if (!language || !LANGUAGE_MAP[language]) {
    res.status(400).json({
      success: false,
      error: "Unsupported or missing \"language\". Supported: " + Object.keys(LANGUAGE_MAP).join(", ") + ".",
    });
    return;
  }
  if (!sourceCode.trim()) {
    res.status(400).json({ success: false, error: "No source code provided — the editor is empty." });
    return;
  }

  log("Executing", language, "- source length", sourceCode.length, "- stdin length", stdin.length);

  try {
    var langInfo = await resolveLanguageId(backend, language);
    var result = await submitToJudge0(backend, langInfo.id, sourceCode, stdin);
    var described = describeStatus(result);

    log(
      "Result for",
      language,
      "(" + langInfo.name + "):",
      described.label,
      "- time",
      result.time,
      "- memory",
      result.memory
    );

    res.status(200).json({
      success: true,
      statusId: result && result.status && result.status.id,
      statusLabel: described.label,
      statusState: described.cssState,
      stdout: b64decode(result.stdout),
      stderr: b64decode(result.stderr),
      compileOutput: b64decode(result.compile_output),
      message: b64decode(result.message),
      time: result.time,
      memory: result.memory,
      exitCode: result.exit_code,
      languageUsed: langInfo.name,
    });
  } catch (err) {
    logError("Execution failed:", err && err.message);
    var status = (err && err.status) || 502;
    res.status(status >= 400 && status < 600 ? status : 502).json({
      success: false,
      error: "Code execution request failed: " + (err && err.message),
    });
  }
};
