/**
 * helper-service/orcid-client.js
 * Core ORCID Public API v3.0 client logic with full work detail and Crossref enrichment.
 *
 * Implements:
 * - ORCID iD normalization and ISO 7064 MOD 11-2 checksum validation
 * - 2-legged OAuth 2.0 /read-public token retrieval & caching
 * - Fetching public works summary from https://pub.orcid.org/v3.0/{orcid}/works
 * - Fetching complete work details from https://pub.orcid.org/v3.0/{orcid}/work/{putCode}
 *   and bulk work details from https://pub.orcid.org/v3.0/{orcid}/works/{putCodes}
 * - BibTeX citation parsing (extracts volume, issue, pages, journal, authors)
 * - Public Crossref API enrichment for DOI-matched records
 * - Precedence rules for merging ORCID and Crossref metadata
 * - Metadata quality assessment (available fields, enriched fields, missing fields)
 */

const https = require('https');
const http = require('http');
const { CrossrefClient, normalizeDoi, formatDateParts } = require('./crossref-client');

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

/**
 * Parse BibTeX citation string into structured fields.
 * Extracts author, title, journal, volume, number/issue, pages, year, doi.
 *
 * @param {string} bibtex
 * @returns {object}
 */
function parseBibtexCitation(bibtex) {
  if (!bibtex || typeof bibtex !== 'string') return {};
  const result = {};

  // Extract key-value pairs: key = {val} or key = "val" or key = val
  const fieldRegex = /([a-zA-Z_-]+)\s*=\s*(?:\{([^}]*)\}|"([^"]*)"|([0-9a-zA-Z_-]+))/g;
  let match;
  while ((match = fieldRegex.exec(bibtex)) !== null) {
    const key = match[1].toLowerCase();
    const val = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (val) {
      result[key] = val;
    }
  }

  // Parse BibTeX author list: "Author One and Author Two and Organization"
  if (result.author) {
    const rawAuthors = result.author.split(/\s+and\s+/i);
    result.authors = rawAuthors.map(a => a.trim()).filter(Boolean);
  }

  return result;
}

/**
 * Parse ORCID contributor records.
 * Supports credit-name, given/family names, ORCID, sequence, and institutional authors.
 *
 * @param {object} contributorsObj
 * @returns {Array<object>}
 */
function parseOrcidContributors(contributorsObj) {
  if (!contributorsObj) return [];
  const rawList = Array.isArray(contributorsObj.contributor)
    ? contributorsObj.contributor
    : (contributorsObj.contributor ? [contributorsObj.contributor] : []);

  const parsed = [];
  const orgPattern = /\b(collaboration|consortium|group|team|committee|initiative|organization|organisation|university|institute|centre|center|department|laboratory|lab|agency|commission|foundation)\b/i;

  for (const c of rawList) {
    if (!c) continue;
    const creditName = c['credit-name']?.value?.trim() || '';
    const orcidUri = c['contributor-orcid']?.uri || c['contributor-orcid']?.path || null;
    const orcidId = orcidUri ? orcidUri.replace(/^https?:\/\/orcid\.org\//i, '').trim() : null;
    const sequence = c['contributor-attributes']?.['contributor-sequence'] || 'additional';
    const role = c['contributor-attributes']?.['contributor-role'] || 'author';

    if (creditName) {
      if (orgPattern.test(creditName) && !creditName.includes(',')) {
        parsed.push({
          lastName: creditName,
          firstName: '',
          fullName: creditName,
          fieldMode: 1,
          creatorType: 'author',
          orcid: orcidId,
          sequence,
          role
        });
      } else if (creditName.includes(',')) {
        const parts = creditName.split(',').map(p => p.trim());
        const family = parts[0] || '';
        const given = parts.slice(1).join(' ') || '';
        parsed.push({
          firstName: given,
          lastName: family || 'Unknown',
          fullName: [given, family].filter(Boolean).join(' ') || family,
          creatorType: 'author',
          orcid: orcidId,
          sequence,
          role
        });
      } else {
        const spaceParts = creditName.split(/\s+/);
        if (spaceParts.length === 1) {
          parsed.push({
            lastName: creditName,
            firstName: '',
            fullName: creditName,
            fieldMode: 1,
            creatorType: 'author',
            orcid: orcidId,
            sequence,
            role
          });
        } else {
          const family = spaceParts.pop();
          const given = spaceParts.join(' ');
          parsed.push({
            firstName: given,
            lastName: family || 'Unknown',
            fullName: creditName,
            creatorType: 'author',
            orcid: orcidId,
            sequence,
            role
          });
        }
      }
    }
  }

  return parsed;
}

/**
 * Format ORCID publication-date object { year, month, day } to ISO partial string.
 * @param {object} dateObj
 * @returns {string|null}
 */
function formatOrcidDate(dateObj) {
  if (!dateObj || !dateObj.year?.value) return null;
  const y = String(dateObj.year.value).trim();
  const m = dateObj.month?.value ? String(dateObj.month.value).padStart(2, '0') : null;
  const d = dateObj.day?.value ? String(dateObj.day.value).padStart(2, '0') : null;

  if (m && d) return `${y}-${m}-${d}`;
  if (m) return `${y}-${m}`;
  return y;
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

    // Crossref integration client
    this.crossrefClient = options.crossrefClient || new CrossrefClient(options.crossrefOptions || {});

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
   * Fetch single work detail from ORCID v3.0: GET /v3.0/{orcid}/work/{putCode}
   *
   * @param {string} orcid
   * @param {number|string} putCode
   * @returns {Promise<object|null>}
   */
  async fetchWorkDetail(orcid, putCode) {
    if (!putCode) return null;
    const token = await this.getReadPublicToken();
    const url = `${this.apiBase}/${orcid}/work/${putCode}`;

    try {
      const res = await this._request(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Zotero-ORCID-Assistant/1.0'
        }
      });

      if (res && res.statusCode === 200 && res.data) {
        return this.parseOrcidWorkDetail(res.data);
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch work details in bulk from ORCID v3.0: GET /v3.0/{orcid}/works/{putCodes}
   * Batches requests in chunks of up to 50 put codes.
   *
   * @param {string} orcid
   * @param {Array<number|string>} putCodes
   * @returns {Promise<Map<number, object>>}
   */
  async fetchWorksDetailsBulk(orcid, putCodes) {
    const detailMap = new Map();
    if (!Array.isArray(putCodes) || putCodes.length === 0) return detailMap;

    const token = await this.getReadPublicToken();
    const chunkSize = 50;

    for (let i = 0; i < putCodes.length; i += chunkSize) {
      const chunk = putCodes.slice(i, i + chunkSize);
      const putCodesStr = chunk.join(',');
      const url = `${this.apiBase}/${orcid}/works/${putCodesStr}`;

      try {
        const res = await this._request(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Zotero-ORCID-Assistant/1.0'
          }
        });

        if (res && res.statusCode === 200 && res.data) {
          const bulkItems = Array.isArray(res.data.bulk) ? res.data.bulk : [];
          for (const item of bulkItems) {
            if (item && item.work) {
              const parsed = this.parseOrcidWorkDetail(item.work);
              if (parsed && parsed.putCode) {
                detailMap.set(parsed.putCode, parsed);
              }
            }
          }
        }
      } catch (err) {
        // Fall back gracefully; works without bulk detail will retain summary fields
      }
    }

    return detailMap;
  }

  /**
   * Parse a full ORCID work detail payload (<work:work>).
   *
   * @param {object} workData
   * @returns {object}
   */
  parseOrcidWorkDetail(workData) {
    if (!workData) return null;

    const putCode = workData['put-code'] || null;
    const titleObj = workData.title || {};
    const rawTitle = titleObj.title?.value || null;
    const rawSubtitle = titleObj.subtitle?.value || null;

    let title = rawTitle;
    if (title && rawSubtitle && !title.toLowerCase().includes(rawSubtitle.toLowerCase())) {
      title = `${title}: ${rawSubtitle}`;
    }

    const journalTitle = workData['journal-title']?.value?.trim() || null;
    const date = formatOrcidDate(workData['publication-date']);
    const year = date ? date.split('-')[0] : (workData['publication-date']?.year?.value || null);
    const type = workData.type || 'journal-article';
    const url = workData.url?.value?.trim() || null;
    const shortDescription = workData['short-description']?.trim() || null;
    const languageCode = workData['language-code']?.value?.trim() || null;

    // External IDs: DOI, ISSN, ISBN
    let doi = null;
    let issn = null;
    let isbn = null;
    const externalIds = workData['external-ids']?.['external-id'] || [];
    for (const ext of externalIds) {
      const extType = (ext['external-id-type'] || '').toLowerCase();
      const val = ext['external-id-value']?.trim() || '';
      if (!val) continue;

      if (extType === 'doi' && !doi) {
        doi = normalizeDoi(val);
      } else if (extType === 'issn' && !issn) {
        issn = val;
      } else if (extType === 'isbn' && !isbn) {
        isbn = val;
      }
    }

    // Contributors
    const contributors = parseOrcidContributors(workData.contributors);

    // Citation & BibTeX parsing
    let citation = null;
    let bibtexParsed = null;
    if (workData.citation) {
      const citType = workData.citation['citation-type'] || '';
      const citVal = workData.citation['citation-value'] || '';
      citation = { type: citType, value: citVal };
      if (citType.toLowerCase().includes('bibtex') || citVal.trim().startsWith('@')) {
        bibtexParsed = parseBibtexCitation(citVal);
      }
    }

    return {
      source: 'orcid',
      putCode,
      title: title || '(Untitled ORCID Work)',
      subtitle: rawSubtitle,
      journalTitle,
      date,
      year,
      type,
      url,
      doi,
      issn,
      isbn,
      contributors,
      citation,
      bibtexParsed,
      shortDescription,
      languageCode
    };
  }

  /**
   * Merge ORCID summary, ORCID detail, and Crossref metadata using strict precedence rules.
   *
   * Precedence Rules:
   * 1. DOI Matching Guard: Crossref data is used ONLY if normalized response DOI matches requested DOI.
   * 2. Authors / Creators:
   *    - Crossref structured authors take precedence when available (full given/family names, sequence, institutional names).
   *    - Fall back to ORCID detail contributors if Crossref has no authors.
   *    - Fall back to BibTeX citation authors if ORCID detail has no structured contributors.
   *    - Fall back to summary assertion-origin-name only as a last resort.
   * 3. Title & Subtitle:
   *    - Prefer Crossref/ORCID title, combining subtitle if not already included.
   * 4. Journal / Container Title:
   *    - Prefer Crossref containerTitle, falling back to ORCID journalTitle, then BibTeX journal.
   * 5. Volume, Issue, Pages:
   *    - Prefer Crossref volume, issue, page / articleNumber.
   *    - Fall back to BibTeX volume, number, pages.
   * 6. Date:
   *    - Prefer Crossref complete date (YYYY-MM-DD or YYYY-MM), falling back to ORCID publication date, then year.
   * 7. ISSN / ISBN:
   *    - Merge Crossref and ORCID external IDs.
   * 8. URL:
   *    - Prefer canonical Crossref URL / DOI link, falling back to ORCID URL.
   * 9. Abstract:
   *    - Prefer Crossref abstract (stripped of JATS tags), falling back to ORCID shortDescription.
   *
   * @param {string} orcid
   * @param {object} summaryWork
   * @param {object} detailWork
   * @param {object} crossrefData
   * @returns {object}
   */
  enrichWork(orcid, summaryWork, detailWork, crossrefData) {
    const putCode = detailWork?.putCode || summaryWork?.putCode || null;
    const rawDoi = detailWork?.doi || summaryWork?.doi || crossrefData?.doi || null;
    const normDoi = normalizeDoi(rawDoi);

    // Guard: Only use Crossref data if DOI matches
    const cr = (crossrefData && crossrefData.doi === normDoi) ? crossrefData : null;
    const sources = ['orcid'];
    const enrichedFields = [];

    // Title
    let title = cr?.title || detailWork?.title || summaryWork?.title || '(Untitled Publication)';
    if (!cr?.title && detailWork?.subtitle && !title.toLowerCase().includes(detailWork.subtitle.toLowerCase())) {
      title = `${title}: ${detailWork.subtitle}`;
    }

    // Authors
    let authors = [];
    if (cr && Array.isArray(cr.authors) && cr.authors.length > 0) {
      authors = cr.authors;
      sources.push('crossref');
      enrichedFields.push('authors');
    } else if (detailWork && Array.isArray(detailWork.contributors) && detailWork.contributors.length > 0) {
      authors = detailWork.contributors;
    } else if (detailWork?.bibtexParsed?.authors && detailWork.bibtexParsed.authors.length > 0) {
      authors = detailWork.bibtexParsed.authors.map(rawName => {
        const parts = rawName.includes(',') ? rawName.split(',').map(s => s.trim()) : null;
        if (parts) {
          return { firstName: parts.slice(1).join(' '), lastName: parts[0] || 'Unknown', fullName: rawName, creatorType: 'author' };
        }
        const spaceParts = rawName.trim().split(/\s+/);
        if (spaceParts.length === 1) {
          return { lastName: rawName, firstName: '', fullName: rawName, fieldMode: 1, creatorType: 'author' };
        }
        const last = spaceParts.pop();
        const first = spaceParts.join(' ');
        return { firstName: first, lastName: last, fullName: rawName, creatorType: 'author' };
      });
    } else if (summaryWork && Array.isArray(summaryWork.authors) && summaryWork.authors.length > 0) {
      authors = summaryWork.authors.map(a => typeof a === 'string' ? { fullName: a, lastName: a, creatorType: 'author' } : a);
    }

    const authorString = authors.length > 0
      ? authors.map(a => a.fullName || a.lastName || a).join(', ')
      : null;

    // Journal / Container Title
    let journalTitle = null;
    if (cr && cr.containerTitle) {
      journalTitle = cr.containerTitle;
      if (!enrichedFields.includes('journalTitle')) enrichedFields.push('journalTitle');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork && detailWork.journalTitle) {
      journalTitle = detailWork.journalTitle;
    } else if (detailWork?.bibtexParsed?.journal) {
      journalTitle = detailWork.bibtexParsed.journal;
    } else if (summaryWork && summaryWork.journalTitle) {
      journalTitle = summaryWork.journalTitle;
    }

    // Journal Abbreviation
    const journalAbbreviation = cr?.shortContainerTitle || null;
    if (journalAbbreviation && !enrichedFields.includes('journalAbbreviation')) {
      enrichedFields.push('journalAbbreviation');
    }

    // Volume, Issue, Pages
    let volume = null;
    if (cr && cr.volume) {
      volume = cr.volume;
      enrichedFields.push('volume');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork?.bibtexParsed?.volume) {
      volume = detailWork.bibtexParsed.volume;
    }

    let issue = null;
    if (cr && cr.issue) {
      issue = cr.issue;
      enrichedFields.push('issue');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork?.bibtexParsed?.number) {
      issue = detailWork.bibtexParsed.number;
    }

    let pages = null;
    if (cr && cr.pages) {
      pages = cr.pages;
      enrichedFields.push('pages');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork?.bibtexParsed?.pages) {
      pages = detailWork.bibtexParsed.pages;
    }

    // Publication Date & Year
    let date = null;
    if (cr && cr.date) {
      date = cr.date;
      enrichedFields.push('date');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork && detailWork.date) {
      date = detailWork.date;
    } else if (summaryWork && summaryWork.year && summaryWork.year !== 'Unknown') {
      date = String(summaryWork.year);
    } else if (detailWork?.bibtexParsed?.year) {
      date = String(detailWork.bibtexParsed.year);
    }
    const year = date ? date.split('-')[0] : (summaryWork?.year || 'Unknown');

    // Publisher
    let publisher = null;
    if (cr && cr.publisher) {
      publisher = cr.publisher;
      enrichedFields.push('publisher');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork?.bibtexParsed?.publisher) {
      publisher = detailWork.bibtexParsed.publisher;
    }

    // ISSN & ISBN
    const issn = cr?.issn || detailWork?.issn || null;
    if (cr?.issn && !enrichedFields.includes('issn')) enrichedFields.push('issn');

    const isbn = cr?.isbn || detailWork?.isbn || null;
    if (cr?.isbn && !enrichedFields.includes('isbn')) enrichedFields.push('isbn');

    // URL
    let url = null;
    if (cr && cr.url) {
      url = cr.url;
      if (!enrichedFields.includes('url')) enrichedFields.push('url');
    } else if (normDoi) {
      url = `https://doi.org/${normDoi}`;
    } else if (detailWork && detailWork.url) {
      url = detailWork.url;
    } else if (summaryWork && summaryWork.url) {
      url = summaryWork.url;
    }

    // Abstract Note
    let abstractNote = null;
    if (cr && cr.abstractNote) {
      abstractNote = cr.abstractNote;
      enrichedFields.push('abstractNote');
      if (!sources.includes('crossref')) sources.push('crossref');
    } else if (detailWork && detailWork.shortDescription) {
      abstractNote = detailWork.shortDescription;
    }

    // Language
    const language = cr?.language || detailWork?.languageCode || null;

    // Work Type
    const type = summaryWork?.type || detailWork?.type || cr?.crossrefType || 'journal-article';

    // Metadata quality assessment
    const availableFields = [];
    const missingFields = [];

    const verifyQualityField = (key, val) => {
      if (val && (typeof val === 'string' ? val.trim().length > 0 : (Array.isArray(val) ? val.length > 0 : true))) {
        availableFields.push(key);
      } else {
        missingFields.push(key);
      }
    };

    verifyQualityField('title', title);
    verifyQualityField('authors', authors);
    verifyQualityField('date', date);
    verifyQualityField('doi', normDoi);
    verifyQualityField('journalTitle', journalTitle);
    verifyQualityField('volume', volume);
    verifyQualityField('issue', issue);
    verifyQualityField('pages', pages);
    verifyQualityField('issn', issn);
    verifyQualityField('url', url);
    verifyQualityField('abstractNote', abstractNote);

    const isCrossrefEnriched = sources.includes('crossref');

    return {
      title,
      doi: normDoi,
      year,
      date,
      type,
      authors,
      author: authorString,
      journalTitle,
      journalAbbreviation,
      volume,
      issue,
      pages,
      publisher,
      issn,
      isbn,
      url,
      abstractNote,
      language,
      putCode,
      orcid,
      sources,
      isEnriched: isCrossrefEnriched,
      enrichedFields,
      metadataQuality: {
        sources,
        sourceSummary: sources.length > 1 ? 'ORCID + Crossref' : 'ORCID',
        isEnriched: isCrossrefEnriched,
        availableFields,
        enrichedFields,
        missingFields,
        completenessScore: Math.round((availableFields.length / (availableFields.length + missingFields.length)) * 100)
      }
    };
  }

  /**
   * Fetch public works for an ORCID profile with full detail and Crossref enrichment.
   *
   * @param {string} rawOrcid
   * @param {{ enrich?: boolean }} options
   * @returns {Promise<{ orcid: string, totalWorks: number, works: Array<object> }>}
   */
  async fetchPublicWorks(rawOrcid, options = { enrich: true }) {
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

    // Extract initial summary list
    const summaryWorks = groups.map(group => {
      const summaryList = group['work-summary'] || [];
      const summary = summaryList[0] || {};

      const title = summary.title?.title?.value || 'Untitled Work';
      const year = summary['publication-date']?.year?.value || 'Unknown';
      const type = summary.type || 'journal-article';
      const putCode = summary['put-code'] || null;
      const journalTitle = summary['journal-title']?.value || null;

      let doi = null;
      const externalIds = summary['external-ids']?.['external-id'] || [];
      for (const ext of externalIds) {
        if (ext['external-id-type']?.toLowerCase() === 'doi' && ext['external-id-value']) {
          doi = normalizeDoi(ext['external-id-value']);
          break;
        }
      }

      let authors = [];
      if (summary.contributors?.contributor) {
        const contribs = Array.isArray(summary.contributors.contributor)
          ? summary.contributors.contributor
          : [summary.contributors.contributor];
        for (const c of contribs) {
          const name = c['credit-name']?.value;
          if (name && !authors.includes(name)) {
            authors.push(name);
          }
        }
      }
      if (authors.length === 0 && summary.source?.['assertion-origin-name']?.value) {
        authors.push(summary.source['assertion-origin-name'].value);
      }
      const author = authors.length > 0 ? authors.join(', ') : null;

      return {
        title,
        doi,
        year,
        type,
        authors,
        author,
        putCode,
        journalTitle
      };
    });

    if (options.enrich === false) {
      return {
        orcid,
        totalWorks: summaryWorks.length,
        works: summaryWorks
      };
    }

    // 1. Fetch ORCID work details in bulk
    const putCodes = summaryWorks.map(w => w.putCode).filter(Boolean);
    let detailMap = new Map();
    if (putCodes.length > 0) {
      try {
        detailMap = await this.fetchWorksDetailsBulk(orcid, putCodes);
      } catch (err) {
        // If bulk fetch fails, detailMap remains empty and summary fields are used
      }
    }

    // 2. Fetch Crossref metadata for works with a DOI
    const uniqueDois = [...new Set(summaryWorks.map(w => w.doi).filter(Boolean))];
    const crossrefMap = new Map();

    if (uniqueDois.length > 0 && this.crossrefClient) {
      const crPromises = uniqueDois.map(async (doi) => {
        try {
          const crData = await this.crossrefClient.fetchByDoi(doi);
          if (crData) {
            crossrefMap.set(doi, crData);
          }
        } catch (e) {
          // Crossref is non-blocking
        }
      });
      await Promise.allSettled(crPromises);
    }

    // 3. Merge each work with its detail and Crossref metadata
    const enrichedWorks = summaryWorks.map(summaryWork => {
      const detail = summaryWork.putCode ? detailMap.get(summaryWork.putCode) : null;
      const effectiveDoi = detail?.doi || summaryWork.doi;
      const crData = effectiveDoi ? crossrefMap.get(effectiveDoi) : null;

      return this.enrichWork(orcid, summaryWork, detail, crData);
    });

    return {
      orcid,
      totalWorks: enrichedWorks.length,
      works: enrichedWorks
    };
  }
}

module.exports = {
  validateAndNormalizeOrcid,
  parseBibtexCitation,
  parseOrcidContributors,
  formatOrcidDate,
  OrcidClient
};
