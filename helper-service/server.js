/**
 * helper-service/server.js
 * Local-only Node.js helper service for ORCID Assistant.
 *
 * Security & Design:
 * - Strictly bound to 127.0.0.1 (localhost only).
 * - Reads ORCID Public API credentials from .env.
 * - Never exposes or logs client secrets or access tokens.
 * - Clean HTTP REST API consumed by the Zotero plugin.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { validateAndNormalizeOrcid, OrcidClient } = require('./orcid-client');

// Simple built-in .env loader (zero external dependency)
function loadEnv() {
  const envPaths = [
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '.env')
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch (e) {
        console.error('[Helper Service] Error reading .env:', e.message);
      }
      break;
    }
  }
}

loadEnv();

const HOST = '127.0.0.1'; // Enforce localhost binding only
const PORT = parseInt(process.env.PORT || '23125', 10);

const orcidClient = new OrcidClient();

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = reqUrl.pathname;

  // 1. Health / Status Check
  if (pathname === '/health' || pathname === '/status') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'orcid-assistant-helper',
      host: HOST,
      port: PORT,
      hasCredentials: orcidClient.hasValidCredentials()
    });
  }

  // 2. Fetch Public Works API
  // Supported via GET /api/works?orcid=... or POST /api/fetch-works with JSON { orcid: "..." }
  if (pathname === '/api/works' || pathname === '/api/fetch-works') {
    let rawOrcid = reqUrl.searchParams.get('orcid');

    if (!rawOrcid && req.method === 'POST') {
      try {
        const bodyBuffer = await new Promise((resolve, reject) => {
          let chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        });
        if (bodyBuffer) {
          const bodyJson = JSON.parse(bodyBuffer);
          rawOrcid = bodyJson.orcid;
        }
      } catch (parseErr) {
        return sendJson(res, 400, {
          success: false,
          error: 'Invalid JSON body. Please provide {"orcid": "0000-0000-0000-0000"}'
        });
      }
    }

    if (!rawOrcid) {
      return sendJson(res, 400, {
        success: false,
        error: 'Missing required parameter "orcid". Example: ?orcid=0000-0002-1825-0097'
      });
    }

    // Validate format before attempting external fetch
    const validation = validateAndNormalizeOrcid(rawOrcid);
    if (!validation.valid) {
      return sendJson(res, 400, {
        success: false,
        error: validation.error,
        orcid: rawOrcid
      });
    }

    if (!orcidClient.hasValidCredentials()) {
      return sendJson(res, 503, {
        success: false,
        error: 'ORCID Public API credentials not configured in helper .env file. Please set ORCID_CLIENT_ID and ORCID_CLIENT_SECRET.',
        orcid: validation.orcid
      });
    }

    try {
      console.log(`[Helper Service] Fetching works for ORCID: ${validation.orcid}`);
      const result = await orcidClient.fetchPublicWorks(validation.orcid);
      console.log(`[Helper Service] Successfully retrieved ${result.totalWorks} works for ORCID: ${validation.orcid}`);

      return sendJson(res, 200, {
        success: true,
        data: result
      });
    } catch (err) {
      console.error(`[Helper Service] Error fetching works: ${err.message}`);
      return sendJson(res, 500, {
        success: false,
        error: err.message,
        orcid: validation.orcid
      });
    }
  }

  // 404 Fallback
  sendJson(res, 404, {
    success: false,
    error: `Endpoint not found: ${pathname}`
  });
});

function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      console.log(`=======================================================`);
      console.log(` ORCID Assistant Helper Service Started`);
      console.log(` Endpoint: http://${host}:${port}`);
      console.log(` Credentials Status: ${orcidClient.hasValidCredentials() ? 'Configured ✔' : 'Missing in .env ⚠'}`);
      console.log(`=======================================================`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// Auto-start when executed directly
if (require.main === module) {
  startServer().catch(err => {
    console.error('[Helper Service] Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = {
  server,
  startServer,
  orcidClient,
  loadEnv
};
