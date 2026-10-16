/**
 * helper-service/orcid-client.js
 * Core ORCID Public API v3.0 client logic.
 *
 * Implements:
 * - ORCID iD normalization and ISO 7064 MOD 11-2 checksum validation
 * - 2-legged OAuth 2.0 /read-public token retrieval & caching
 * - Fetching public works from https://pub.orcid.org/v3.0/{orcid}/works
 * - Safe response sanitization (no access tokens or client secrets logged/exposed)
 */

const https = require('https');
const http = require('http');

/**
 * Validate an ORCID string using regex and ISO 7064 MOD 11-2 check digit.
 * Supported inputs:
 * - 0000-0002-1825-0097
 * - https://orcid.org/0000-0002-1825-0097
 * - orcid.org/0000-0002-1825-0097
 *
 * @param {string} rawOrcid
 * @returns {{ valid: boolean, orcid: string, error?: string }}
 */
function validateAndNormalizeOrcid(rawOrcid) {
  if (!rawOrcid || typeof rawOrcid !== 'string') {
    return { valid: false, orcid: '', error: 'ORCID iD must be a non-empty string' };
  }

  // Strip URL prefix and whitespace
  let cleaned = rawOrcid.trim().replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '').replace(/^orcid\.org\//i, '');

  // Check 16-character format with hyphens (0000-0000-0000-0000 to 0000-0000-0000-000X)
  const orcidRegex = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i;
  if (!orcidRegex.test(cleaned)) {
    return {
      valid: false,
      orcid: cleaned,
      error: 'Invalid ORCID format. Expected format: 0000-0000-0000-0000 (16 digits or 15 digits ending in X)'
    };
  }

  // Canonicalize uppercase check digit
  cleaned = cleaned.slice(0, 18) + cleaned.charAt(18).toUpperCase();

  // Validate ISO 7064 MOD 11-2 checksum
  const digits = cleaned.replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) {
    total = (total + parseInt(digits[i], 10)) * 2;
  }
  const remainder = total % 11;
  const result = (12 - remainder) % 11;
  const expectedCheckDigit = result === 10 ? 'X' : String(result);

  if (expectedCheckDigit !== digits[15]) {
    return {
      valid: false,
      orcid: cleaned,
      error: `Invalid ORCID checksum digit (expected '${expectedCheckDigit}', got '${digits[15]}')`
    };
  }

  return { valid: true, orcid: cleaned };
}

class OrcidClient {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.ORCID_CLIENT_ID || '';
    this.clientSecret = options.clientSecret || process.env.ORCID_CLIENT_SECRET || '';
    this.tokenEndpoint = options.tokenEndpoint || 'https://orcid.org/oauth/token';
    this.apiBase = options.apiBase || 'https://pub.orcid.org/v3.0';
    this.timeoutMs = options.timeoutMs || 10000;
    this.cachedToken = null;
    this.tokenExpiresAt = 0;

    // Optional custom fetcher for testing
    this.customFetch = options.customFetch || null;
  }

  hasValidCredentials() {
    return Boolean(
      this.clientId &&
      this.clientSecret &&
      !this.clientId.includes('XXXX') &&
      !this.clientSecret.includes('00000000')
    );
  }

  /**
   * Internal HTTP request helper.
   */
  async _request(urlStr, options = {}, postData = null) {
    if (this.customFetch) {
      return this.customFetch(urlStr, options, postData);
    }

    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const protocol = url.protocol === 'https:' ? https : http;

      const reqOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: this.timeoutMs
      };

      const req = protocol.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = body;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsed
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`Network error: ${err.message}`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * Obtain a 2-legged OAuth 2.0 access token with scope /read-public.
   */
  async getReadPublicToken() {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.cachedToken;
    }

    if (!this.hasValidCredentials()) {
      throw new Error('ORCID Public API credentials not configured in helper .env file (missing ORCID_CLIENT_ID or ORCID_CLIENT_SECRET)');
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
      scope: '/read-public'
    });

    const postBody = params.toString();

    const res = await this._request(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'User-Agent': 'Zotero-ORCID-Assistant/1.0'
      }
    }, postBody);

    if (res.statusCode !== 200 || !res.data || !res.data.access_token) {
      const errMsg = res.data?.error_description || res.data?.error || `HTTP ${res.statusCode}`;
      throw new Error(`Failed to obtain ORCID /read-public access token: ${errMsg}`);
    }

    this.cachedToken = res.data.access_token;
    const expiresIn = typeof res.data.expires_in === 'number' ? res.data.expires_in : 3600;
    this.tokenExpiresAt = Date.now() + expiresIn * 1000;

    return this.cachedToken;
  }

  /**
   * Fetch public works for a validated ORCID iD.
   *
   * @param {string} rawOrcid
   * @returns {Promise<{ orcid: string, totalWorks: number, works: Array<{ title: string, doi: string|null, year: string, type: string, putCode: number|null }> }>}
   */
  async fetchPublicWorks(rawOrcid) {
    const validation = validateAndNormalizeOrcid(rawOrcid);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const orcid = validation.orcid;

    const token = await this.getReadPublicToken();

    const worksUrl = `${this.apiBase}/${orcid}/works`;
    const res = await this._request(worksUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Zotero-ORCID-Assistant/1.0'
      }
    });

    if (res.statusCode === 404) {
      throw new Error(`ORCID record '${orcid}' not found on public registry`);
    }

    if (res.statusCode === 403) {
      throw new Error(`Access forbidden for ORCID record '${orcid}' (check permissions or rate limits)`);
    }

    if (res.statusCode !== 200) {
      throw new Error(`ORCID API returned error status HTTP ${res.statusCode}`);
    }

    const payload = res.data;
    const groups = Array.isArray(payload?.group) ? payload.group : [];

    const extractedWorks = groups.map(group => {
      const summaryList = group['work-summary'] || [];
      const summary = summaryList[0] || {};

      // Extract title
      const title = summary.title?.title?.value || 'Untitled Work';

      // Extract DOI if available
      let doi = null;
      const externalIds = summary['external-ids']?.['external-id'] || [];
      for (const ext of externalIds) {
        if (ext['external-id-type']?.toLowerCase() === 'doi' && ext['external-id-value']) {
          doi = ext['external-id-value'].trim();
          break;
        }
      }

      // Extract publication year
      const year = summary['publication-date']?.year?.value || 'Unknown';

      // Extract work type
      const type = summary.type || 'work';

      // Extract put-code
      const putCode = summary['put-code'] || null;

      // Extract journal title
      const journalTitle = summary['journal-title']?.value || null;

      return {
        title,
        doi,
        year,
        type,
        putCode,
        journalTitle
      };
    });

    return {
      orcid,
      totalWorks: extractedWorks.length,
      works: extractedWorks
    };
  }
}

module.exports = {
  validateAndNormalizeOrcid,
  OrcidClient
};
