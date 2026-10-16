/**
 * helper-service/crossref-client.js
 * Public Crossref API client for bibliographic metadata enrichment.
 *
 * Capabilities:
 * - Queries https://api.crossref.org/works/{doi}
 * - Strict DOI validation (rejects mismatched DOIs)
 * - Structured author parsing (given/family names, institutional authors, sequence)
 * - Container title, volume, issue, page range / article number extraction
 * - Publication date formatting (without inventing month/day)
 * - JATS XML abstract cleaning
 * - In-memory cache to prevent repeated queries within a batch
 * - Polite User-Agent header (Crossref polite pool)
 */

const https = require('https');
const http = require('http');

/**
 * Normalize DOI string: strip URL prefixes, lowercase, trim.
 * @param {string} rawDoi
 * @returns {string|null}
 */
function normalizeDoi(rawDoi) {
  if (!rawDoi || typeof rawDoi !== 'string') return null;
  let d = rawDoi.trim();
  d = d.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  d = d.replace(/^doi:\s*/i, '');
  d = d.replace(/\/+$/, '');
  d = d.replace(/\.+$/, '');
  d = d.trim().toLowerCase();
  return d.length > 0 ? d : null;
}

/**
 * Format date-parts array [ [ YYYY, MM, DD ] ] into ISO partial string.
 * Never invents month or day values.
 * @param {Array<Array<number>>} dateParts
 * @returns {string|null}
 */
function formatDateParts(dateParts) {
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) return null;
  const parts = dateParts[0];
  const year = parts[0];
  if (!year || typeof year !== 'number') return null;

  const yStr = String(year);
  const m = parts[1];
  const d = parts[2];

  if (m && typeof m === 'number') {
    const mStr = String(m).padStart(2, '0');
    if (d && typeof d === 'number') {
      const dStr = String(d).padStart(2, '0');
      return `${yStr}-${mStr}-${dStr}`;
    }
    return `${yStr}-${mStr}`;
  }
  return yStr;
}

/**
 * Clean JATS XML tags or HTML from Crossref abstract strings.
 * @param {string} rawAbstract
 * @returns {string|null}
 */
function cleanAbstract(rawAbstract) {
  if (!rawAbstract || typeof rawAbstract !== 'string') return null;
  let cleaned = rawAbstract
    .replace(/<jats:[^>]+>/gi, '')
    .replace(/<\/jats:[^>]+>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

class CrossrefClient {
  constructor(options = {}) {
    this.apiBase = options.apiBase || 'https://api.crossref.org/works';
    this.timeoutMs = options.timeoutMs || 8000;
    this.userAgent = options.userAgent || 'Zotero-ORCID-Assistant/1.0 (mailto:orcid-assistant@zotero.org)';
    this.cache = new Map();
    this.customFetch = options.customFetch || null;
  }

  /**
   * Internal HTTP request helper.
   */
  async _request(urlStr) {
    if (this.customFetch) {
      return this.customFetch(urlStr);
    }

    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const protocol = url.protocol === 'https:' ? https : http;

      const reqOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': this.userAgent
        },
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
        reject(new Error(`Crossref request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`Crossref network error: ${err.message}`));
      });

      req.end();
    });
  }

  /**
   * Fetch bibliographic metadata for a DOI from Crossref.
   * Caches responses in-memory to prevent repeated network requests for the same DOI.
   *
   * @param {string} rawDoi
   * @returns {Promise<object|null>}
   */
  async fetchByDoi(rawDoi) {
    const normDoi = normalizeDoi(rawDoi);
    if (!normDoi) return null;

    if (this.cache.has(normDoi)) {
      return this.cache.get(normDoi);
    }

    const queryPromise = this._fetchByDoiInternal(normDoi);
    this.cache.set(normDoi, queryPromise);

    try {
      return await queryPromise;
    } catch (err) {
      // Don't poison cache with transient failures
      this.cache.delete(normDoi);
      throw err;
    }
  }

  async _fetchByDoiInternal(normDoi) {
    const encoded = encodeURIComponent(normDoi);
    const url = `${this.apiBase}/${encoded}`;

    let res;
    try {
      res = await this._request(url);
    } catch (err) {
      return null;
    }

    if (!res || res.statusCode === 404 || res.statusCode >= 500) {
      return null;
    }

    if (res.statusCode !== 200 || !res.data || !res.data.message) {
      return null;
    }

    const msg = res.data.message;

    // Strict DOI verification: Crossref DOI must match the requested normalized DOI
    const responseDoi = normalizeDoi(msg.DOI);
    if (!responseDoi || responseDoi !== normDoi) {
      return null;
    }

    return this.parseCrossrefMessage(msg, normDoi);
  }

  /**
   * Parse a raw Crossref message object into structured bibliographic metadata.
   */
  parseCrossrefMessage(msg, normDoi) {
    // Title & subtitle
    const rawTitle = Array.isArray(msg.title) && msg.title.length > 0 ? msg.title[0] : null;
    const rawSubtitle = Array.isArray(msg.subtitle) && msg.subtitle.length > 0 ? msg.subtitle[0] : null;

    let title = rawTitle;
    if (title && rawSubtitle && !title.toLowerCase().includes(rawSubtitle.toLowerCase())) {
      title = `${title}: ${rawSubtitle}`;
    }

    // Authors / Contributors
    const authors = [];
    if (Array.isArray(msg.author)) {
      for (const a of msg.author) {
        if (!a) continue;

        // Institutional or organization author (e.g., {"name": "CERN Collaboration"})
        if (a.name && typeof a.name === 'string') {
          const orgName = a.name.trim();
          if (orgName) {
            authors.push({
              lastName: orgName,
              firstName: '',
              fullName: orgName,
              fieldMode: 1,
              creatorType: 'author',
              sequence: a.sequence || 'additional'
            });
          }
          continue;
        }

        // Personal author
        const given = (a.given || '').trim();
        const family = (a.family || '').trim();
        if (family || given) {
          const fullName = [given, family].filter(Boolean).join(' ');
          authors.push({
            firstName: given,
            lastName: family || 'Unknown',
            fullName: fullName || family || 'Unknown',
            orcid: a.ORCID ? a.ORCID.replace(/^https?:\/\/orcid\.org\//i, '').trim() : null,
            sequence: a.sequence || 'additional',
            creatorType: 'author'
          });
        }
      }
    }

    // Container Title (Journal / Book / Conference Title)
    let containerTitle = null;
    if (Array.isArray(msg['container-title']) && msg['container-title'].length > 0) {
      containerTitle = msg['container-title'][0].trim() || null;
    }

    // Short Container Title (Journal Abbreviation)
    let shortContainerTitle = null;
    if (Array.isArray(msg['short-container-title']) && msg['short-container-title'].length > 0) {
      shortContainerTitle = msg['short-container-title'][0].trim() || null;
    }

    // Volume, Issue, Pages
    const volume = msg.volume ? String(msg.volume).trim() : null;
    const issue = msg.issue ? String(msg.issue).trim() : null;
    const page = msg.page ? String(msg.page).trim() : (msg['article-number'] ? String(msg['article-number']).trim() : null);

    // Publisher
    const publisher = msg.publisher ? String(msg.publisher).trim() : null;

    // Publication Date
    const printParts = msg['published-print']?.['date-parts'];
    const onlineParts = msg['published-online']?.['date-parts'];
    const issuedParts = msg.issued?.['date-parts'];
    const chosenDateParts = printParts || onlineParts || issuedParts;

    const date = formatDateParts(chosenDateParts);
    const year = date ? date.split('-')[0] : null;

    // ISSN & ISBN
    let issn = null;
    if (Array.isArray(msg.ISSN) && msg.ISSN.length > 0) {
      issn = msg.ISSN[0].trim();
    } else if (typeof msg.ISSN === 'string') {
      issn = msg.ISSN.trim();
    }

    let isbn = null;
    if (Array.isArray(msg.ISBN) && msg.ISBN.length > 0) {
      isbn = msg.ISBN[0].trim();
    } else if (typeof msg.ISBN === 'string') {
      isbn = msg.ISBN.trim();
    }

    // Canonical Article URL
    const url = msg.URL ? String(msg.URL).trim() : `https://doi.org/${normDoi}`;

    // Abstract
    const abstractNote = cleanAbstract(msg.abstract);

    // Language
    const language = msg.language ? String(msg.language).trim() : null;

    // Crossref Work Type
    const crossrefType = msg.type ? String(msg.type).trim() : null;

    return {
      source: 'crossref',
      doi: normDoi,
      title: title || null,
      subtitle: rawSubtitle || null,
      authors,
      authorCount: authors.length,
      author: authors.length > 0 ? authors.map(a => a.fullName).join(', ') : null,
      containerTitle,
      journalTitle: containerTitle,
      shortContainerTitle,
      journalAbbreviation: shortContainerTitle,
      volume,
      issue,
      page,
      pages: page,
      publisher,
      date,
      year,
      issn,
      isbn,
      url,
      abstractNote,
      language,
      crossrefType
    };
  }
}

module.exports = {
  normalizeDoi,
  formatDateParts,
  cleanAbstract,
  CrossrefClient
};

