/**
 * helper-service/test.js
 * Automated unit and integration test suite for ORCID Assistant Helper Service.
 * Uses mocked HTTP responses to test all flows without requiring live credentials.
 */

const http = require('http');
const { validateAndNormalizeOrcid, OrcidClient } = require('./orcid-client');

console.log('=== Running Automated Tests for Helper Service ===\n');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`FAIL: ${testName}`);
    failedTests++;
  }
}

async function runTests() {
  // 1. ORCID Validation Tests
  console.log('-- 1. ORCID Format & Checksum Validation --');

  // Valid ORCID (Josiah Carberry)
  const v1 = validateAndNormalizeOrcid('0000-0002-1825-0097');
  assert(v1.valid && v1.orcid === '0000-0002-1825-0097', 'Valid standard ORCID iD accepted');

  // Valid ORCID with URL prefix
  const v2 = validateAndNormalizeOrcid('https://orcid.org/0000-0002-1825-0097');
  assert(v2.valid && v2.orcid === '0000-0002-1825-0097', 'Valid ORCID with https:// prefix normalized');

  // Valid ORCID ending in 'X' check digit
  // 0000-0002-9079-593X (Tim Berners-Lee)
  const v3 = validateAndNormalizeOrcid('0000-0002-9079-593X');
  assert(v3.valid && v3.orcid === '0000-0002-9079-593X', 'Valid ORCID ending in "X" check digit accepted');

  // Lowercase 'x' should normalize to uppercase 'X'
  const v4 = validateAndNormalizeOrcid('0000-0002-9079-593x');
  assert(v4.valid && v4.orcid === '0000-0002-9079-593X', 'Lowercase "x" check digit normalized to uppercase');

  // Invalid length / garbage format
  const inv1 = validateAndNormalizeOrcid('12345');
  assert(!inv1.valid, 'Short/malformed string rejected');

  const inv2 = validateAndNormalizeOrcid('0000-0002-1825-009');
  assert(!inv2.valid, '15-digit string rejected');

  // Checksum mismatch (last digit changed from 7 to 8)
  const inv3 = validateAndNormalizeOrcid('0000-0002-1825-0098');
  assert(!inv3.valid && inv3.error.includes('checksum'), 'Checksum mismatch rejected');

  // 2. Missing Credentials Handling
  console.log('\n-- 2. Missing Credentials Handling --');
  const clientNoCreds = new OrcidClient({ clientId: '', clientSecret: '' });
  assert(!clientNoCreds.hasValidCredentials(), 'hasValidCredentials() reports false when credentials missing');

  try {
    await clientNoCreds.getReadPublicToken();
    assert(false, 'Should throw error when credentials missing');
  } catch (err) {
    assert(err.message.includes('credentials not configured'), 'Helpful error thrown when credentials missing');
    assert(!err.message.includes('token') && !err.message.includes('secret'), 'Error does not leak sensitive tokens');
  }

  // 3. Mocked Token Retrieval & Caching
  console.log('\n-- 3. Mocked OAuth Token & Works Retrieval --');

  let tokenEndpointHitCount = 0;
  let worksEndpointHitCount = 0;

  const mockCustomFetch = async (urlStr, options, postData) => {
    if (urlStr.includes('oauth/token')) {
      tokenEndpointHitCount++;
      return {
        statusCode: 200,
        headers: {},
        data: {
          access_token: 'mock-access-token-12345',
          token_type: 'bearer',
          expires_in: 3600,
          scope: '/read-public'
        }
      };
    }

    if (urlStr.includes('/works')) {
      worksEndpointHitCount++;
      return {
        statusCode: 200,
        headers: {},
        data: {
          group: [
            {
              'work-summary': [
                {
                  'put-code': 1001,
                  'title': { 'title': { 'value': 'Sample Research Paper on Quantum Computing' } },
                  'type': 'journal-article',
                  'publication-date': { 'year': { 'value': '2023' } },
                  'journal-title': { 'value': 'Journal of Physics' },
                  'source': {
                    'assertion-origin-name': { 'value': 'Josiah Carberry' }
                  },
                  'contributors': {
                    'contributor': [
                      { 'credit-name': { 'value': 'Josiah Carberry' } },
                      { 'credit-name': { 'value': 'Ada Lovelace' } }
                    ]
                  },
                  'external-ids': {
                    'external-id': [
                      {
                        'external-id-type': 'doi',
                        'external-id-value': '10.1000/182'
                      }
                    ]
                  }
                }
              ]
            },
            {
              'work-summary': [
                {
                  'put-code': 1002,
                  'title': { 'title': { 'value': 'Conference Keynote: Future of Metadata' } },
                  'type': 'conference-paper',
                  'publication-date': { 'year': { 'value': '2024' } },
                  'journal-title': null,
                  'source': {
                    'assertion-origin-name': { 'value': 'Josiah Carberry' }
                  },
                  'external-ids': {
                    'external-id': []
                  }
                }
              ]
            }
          ]
        }
      };
    }

    return { statusCode: 404, headers: {}, data: 'Not found' };
  };

  const mockedClient = new OrcidClient({
    clientId: 'MOCK-CLIENT-ID',
    clientSecret: 'MOCK-CLIENT-SECRET',
    customFetch: mockCustomFetch
  });

  // Test token retrieval
  const token = await mockedClient.getReadPublicToken();
  assert(token === 'mock-access-token-12345', 'Token retrieved successfully from mocked endpoint');
  assert(tokenEndpointHitCount === 1, 'Token endpoint hit once');

  // Verify caching: second call should not re-query token endpoint
  const cachedToken = await mockedClient.getReadPublicToken();
  assert(cachedToken === 'mock-access-token-12345', 'Cached token returned');
  assert(tokenEndpointHitCount === 1, 'Token was cached (hit count remained 1)');

  // Test fetching public works
  const worksResult = await mockedClient.fetchPublicWorks('0000-0002-1825-0097');
  assert(worksResult.orcid === '0000-0002-1825-0097', 'Returned matching normalized ORCID');
  assert(worksResult.totalWorks === 2, 'Parsed 2 works correctly');
  assert(worksResult.works[0].title === 'Sample Research Paper on Quantum Computing', 'Work 1 title parsed');
  assert(worksResult.works[0].doi === '10.1000/182', 'Work 1 DOI parsed');
  assert(worksResult.works[0].year === '2023', 'Work 1 year parsed');
  assert(worksResult.works[0].author.includes('Josiah Carberry'), 'Work 1 author parsed');
  assert(worksResult.works[0].authors.length === 2, 'Work 1 multi-author list parsed');
  assert(worksResult.works[1].title === 'Conference Keynote: Future of Metadata', 'Work 2 title parsed');
  assert(worksResult.works[1].doi === null, 'Work 2 missing DOI handled gracefully as null');
  assert(worksResult.works[1].year === '2024', 'Work 2 year parsed');
  assert(worksResult.works[1].author === 'Josiah Carberry', 'Work 2 fallback to assertion-origin-name');

  // 4. Mocked Error Cases (404, 403, Empty Works)
  console.log('\n-- 4. Error Cases Handling --');

  // 404 record not found
  const client404 = new OrcidClient({
    clientId: 'MOCK',
    clientSecret: 'MOCK',
    customFetch: async (url) => {
      if (url.includes('token')) return { statusCode: 200, data: { access_token: 'tok', expires_in: 3600 } };
      return { statusCode: 404, data: 'Not found' };
    }
  });

  try {
    await client404.fetchPublicWorks('0000-0002-1825-0097');
    assert(false, 'Should throw for 404 record');
  } catch (err) {
    assert(err.message.includes('not found'), '404 record not found handled cleanly');
  }

  // Empty works record
  const clientEmpty = new OrcidClient({
    clientId: 'MOCK',
    clientSecret: 'MOCK',
    customFetch: async (url) => {
      if (url.includes('token')) return { statusCode: 200, data: { access_token: 'tok', expires_in: 3600 } };
      return { statusCode: 200, data: { group: [] } };
    }
  });

  const emptyResult = await clientEmpty.fetchPublicWorks('0000-0002-1825-0097');
  assert(emptyResult.totalWorks === 0 && emptyResult.works.length === 0, 'Empty works record returns totalWorks: 0');

  // 5. Crossref Client Unit Tests
  console.log('\n-- 5. Crossref Client Unit & Enrichment Tests --');
  const { CrossrefClient, normalizeDoi, formatDateParts, cleanAbstract } = require('./crossref-client');

  // 5a: DOI normalization
  assert(normalizeDoi('10.1000/182') === '10.1000/182', 'Normalizes standard DOI');
  assert(normalizeDoi('https://doi.org/10.1000/182') === '10.1000/182', 'Strips https://doi.org/ prefix');
  assert(normalizeDoi('http://dx.doi.org/10.1000/182/') === '10.1000/182', 'Strips http://dx.doi.org/ prefix and trailing slash');
  assert(normalizeDoi('doi: 10.1000/182.') === '10.1000/182', 'Strips doi: prefix and trailing dot');
  assert(normalizeDoi('10.1000/AbC-XyZ') === '10.1000/abc-xyz', 'Normalizes DOI to lowercase');
  assert(normalizeDoi(null) === null, 'null DOI returns null');
  assert(normalizeDoi('') === null, 'Empty string DOI returns null');

  // 5b: Date parts formatting
  assert(formatDateParts([[2022, 11, 15]]) === '2022-11-15', 'Formats full YYYY-MM-DD date parts');
  assert(formatDateParts([[2022, 5]]) === '2022-05', 'Formats YYYY-MM date parts without inventing day');
  assert(formatDateParts([[2022]]) === '2022', 'Formats YYYY date parts without inventing month or day');
  assert(formatDateParts(null) === null, 'null date parts returns null');

  // 5c: Abstract cleaning
  assert(cleanAbstract('<jats:p>Abstract text here.</jats:p>') === 'Abstract text here.', 'Strips JATS tags from abstract');
  assert(cleanAbstract('<b>Bold</b> abstract') === 'Bold abstract', 'Strips HTML tags from abstract');
  assert(cleanAbstract(null) === null, 'null abstract returns null');

  // 5d: Mocked Crossref fetch
  let crossrefHitCount = 0;
  const mockCrossrefFetch = async (urlStr) => {
    crossrefHitCount++;
    if (urlStr.includes('10.1000%2F182') || urlStr.includes('10.1000/182')) {
      return {
        statusCode: 200,
        headers: {},
        data: {
          status: 'ok',
          message: {
            DOI: '10.1000/182',
            title: ['Advanced Quantum Computing Algorithms'],
            subtitle: ['A Practical Overview'],
            'container-title': ['Journal of Quantum Engineering'],
            'short-container-title': ['J. Quantum Eng.'],
            author: [
              { given: 'Alice', family: 'Smith', sequence: 'first', affiliation: [{ name: 'Tech Institute' }] },
              { name: 'CERN Collaboration', sequence: 'additional' }
            ],
            volume: '15',
            issue: '3',
            page: '101-115',
            publisher: 'Academic Press',
            'published-print': { 'date-parts': [[2023, 6, 1]] },
            ISSN: ['1234-5678'],
            ISBN: ['978-0-12-345678-9'],
            URL: 'http://dx.doi.org/10.1000/182',
            abstract: '<jats:p>This study demonstrates quantum advantage.</jats:p>',
            language: 'en',
            type: 'journal-article'
          }
        }
      };
    }

    if (urlStr.includes('10.9999%2Fmismatch')) {
      // Return response with mismatched DOI
      return {
        statusCode: 200,
        headers: {},
        data: {
          status: 'ok',
          message: {
            DOI: '10.9999/different-doi',
            title: ['Unrelated Paper']
          }
        }
      };
    }

    if (urlStr.includes('10.9999%2Ftimeout')) {
      throw new Error('Crossref request timed out after 8000ms');
    }

    return { statusCode: 404, headers: {}, data: { status: 'error' } };
  };

  const crClient = new CrossrefClient({ customFetch: mockCrossrefFetch });

  // Test successful Crossref parse
  const crParsed = await crClient.fetchByDoi('10.1000/182');
  assert(crParsed !== null, 'Crossref returned parsed data for valid DOI');
  assert(crParsed.title === 'Advanced Quantum Computing Algorithms: A Practical Overview', 'Combined title and subtitle');
  assert(crParsed.authors.length === 2, 'Parsed 2 authors (1 personal, 1 institutional)');
  assert(crParsed.authors[0].firstName === 'Alice' && crParsed.authors[0].lastName === 'Smith', 'Parsed personal author given and family');
  assert(crParsed.authors[1].lastName === 'CERN Collaboration' && crParsed.authors[1].fieldMode === 1, 'Parsed institutional author with fieldMode=1');
  assert(crParsed.containerTitle === 'Journal of Quantum Engineering', 'Parsed container title');
  assert(crParsed.journalAbbreviation === 'J. Quantum Eng.', 'Parsed short container title as journalAbbreviation');
  assert(crParsed.volume === '15', 'Parsed volume');
  assert(crParsed.issue === '3', 'Parsed issue');
  assert(crParsed.pages === '101-115', 'Parsed pages');
  assert(crParsed.date === '2023-06-01', 'Parsed complete publication date');
  assert(crParsed.issn === '1234-5678', 'Parsed ISSN');
  assert(crParsed.publisher === 'Academic Press', 'Parsed publisher');
  assert(crParsed.abstractNote === 'This study demonstrates quantum advantage.', 'Parsed and cleaned abstract');
  assert(crParsed.url === 'http://dx.doi.org/10.1000/182', 'Parsed canonical URL');

  // Verify caching: second call does not re-query
  const initialHitCount = crossrefHitCount;
  const crCached = await crClient.fetchByDoi('https://doi.org/10.1000/182');
  assert(crCached !== null && crCached.title === crParsed.title, 'Cached Crossref data retrieved');
  assert(crossrefHitCount === initialHitCount, 'Cache prevented redundant HTTP request for same DOI');

  // Verify strict DOI mismatch guard: must reject mismatched DOI
  const crMismatch = await crClient.fetchByDoi('10.9999/mismatch');
  assert(crMismatch === null, 'Strict DOI guard rejected response with mismatched DOI');

  // Verify 404 and timeout handling
  const cr404 = await crClient.fetchByDoi('10.9999/not-found');
  assert(cr404 === null, 'Crossref 404 returned null cleanly');

  const crTimeout = await crClient.fetchByDoi('10.9999/timeout');
  assert(crTimeout === null, 'Crossref timeout handled gracefully without crashing');

  // 6. BibTeX & ORCID Work Detail Parsing Tests
  console.log('\n-- 6. BibTeX & ORCID Work Detail Parsing Tests --');
  const { parseBibtexCitation, parseOrcidContributors } = require('./orcid-client');

  const rawBibtex = `@article{Carberry_2012,
    title={A Methodology for the Emulation of Architecture},
    volume={5},
    number={11},
    journal={Journal of Psychoceramics},
    publisher={CrossRef test user},
    author={Carberry, Josiah and Lovelace, Ada},
    year={2012},
    month={Feb},
    pages={1-3}
  }`;

  const parsedBib = parseBibtexCitation(rawBibtex);
  assert(parsedBib.title === 'A Methodology for the Emulation of Architecture', 'BibTeX extracted title');
  assert(parsedBib.volume === '5', 'BibTeX extracted volume');
  assert(parsedBib.number === '11', 'BibTeX extracted number (issue)');
  assert(parsedBib.journal === 'Journal of Psychoceramics', 'BibTeX extracted journal');
  assert(parsedBib.pages === '1-3', 'BibTeX extracted pages');
  assert(parsedBib.year === '2012', 'BibTeX extracted year');
  assert(parsedBib.authors.length === 2, 'BibTeX extracted 2 authors');
  assert(parsedBib.authors[0] === 'Carberry, Josiah', 'BibTeX author 1 parsed');

  // Parse ORCID contributors
  const orcidContribs = parseOrcidContributors({
    contributor: [
      {
        'credit-name': { value: 'Dr. Mohit Garg' },
        'contributor-orcid': { path: '0000-0001-5787-7143' },
        'contributor-attributes': { 'contributor-sequence': 'first', 'contributor-role': 'author' }
      },
      {
        'credit-name': { value: 'World Health Organization' }
      }
    ]
  });

  assert(orcidContribs.length === 2, 'Parsed 2 ORCID contributors');
  assert(orcidContribs[0].lastName === 'Garg' && orcidContribs[0].firstName === 'Dr. Mohit', 'Parsed personal contributor');
  assert(orcidContribs[0].orcid === '0000-0001-5787-7143', 'Preserved contributor ORCID');
  assert(orcidContribs[1].lastName === 'World Health Organization' && orcidContribs[1].fieldMode === 1, 'Parsed institutional contributor with fieldMode=1');

  // 7. Metadata Enrichment & Precedence Integration Tests
  console.log('\n-- 7. Metadata Enrichment & Precedence Rules --');
  const enrichedWork = mockedClient.enrichWork(
    '0000-0002-1825-0097',
    { title: 'Short Summary Title', year: '2023', doi: '10.1000/182', putCode: 5001 },
    {
      putCode: 5001,
      title: 'Short Summary Title',
      subtitle: 'Expanded Subtitle',
      journalTitle: 'ORCID Journal Title',
      contributors: [{ 'credit-name': { value: 'ORCID Author' } }],
      bibtexParsed: { volume: '99', number: '1' }
    },
    crParsed // Crossref has Alice Smith, Journal of Quantum Engineering, vol 15, issue 3, pages 101-115
  );

  // Precedence verification
  assert(enrichedWork.title === 'Advanced Quantum Computing Algorithms: A Practical Overview', 'Crossref complete title takes precedence');
  assert(enrichedWork.authors.length === 2, 'Crossref structured authors take precedence over ORCID single author');
  assert(enrichedWork.authors[0].firstName === 'Alice', 'Crossref given name preserved');
  assert(enrichedWork.journalTitle === 'Journal of Quantum Engineering', 'Crossref containerTitle takes precedence over ORCID journal');
  assert(enrichedWork.volume === '15', 'Crossref volume takes precedence over BibTeX');
  assert(enrichedWork.issue === '3', 'Crossref issue takes precedence');
  assert(enrichedWork.pages === '101-115', 'Crossref pages populated');
  assert(enrichedWork.issn === '1234-5678', 'ISSN populated');
  assert(enrichedWork.sources.includes('orcid') && enrichedWork.sources.includes('crossref'), 'Both sources tracked');
  assert(enrichedWork.isEnriched === true, 'Flagged as isEnriched');
  assert(enrichedWork.metadataQuality.enrichedFields.includes('authors'), 'Enriched fields records authors');
  assert(enrichedWork.metadataQuality.enrichedFields.includes('volume'), 'Enriched fields records volume');
  assert(enrichedWork.metadataQuality.completenessScore > 70, 'Completeness score calculated');

  // Fallback verification when Crossref is unavailable (null)
  const fallbackWork = mockedClient.enrichWork(
    '0000-0002-1825-0097',
    { title: 'Work Without Crossref', year: '2021', doi: '10.9999/none', putCode: 5002 },
    {
      putCode: 5002,
      title: 'Work Without Crossref',
      journalTitle: 'ORCID Journal Only',
      contributors: [{ 'credit-name': { value: 'Josiah Carberry' } }],
      bibtexParsed: { volume: '7', number: '2', pages: '50-60' }
    },
    null // Crossref failed / 404
  );

  assert(fallbackWork.title === 'Work Without Crossref', 'Fallback retains ORCID title');
  assert(fallbackWork.journalTitle === 'ORCID Journal Only', 'Fallback retains ORCID journal');
  assert(fallbackWork.volume === '7', 'Fallback extracts volume from BibTeX');
  assert(fallbackWork.issue === '2', 'Fallback extracts issue from BibTeX');
  assert(fallbackWork.pages === '50-60', 'Fallback extracts pages from BibTeX');
  assert(fallbackWork.isEnriched === false, 'Flagged as not Crossref enriched');
  assert(fallbackWork.sources.length === 1 && fallbackWork.sources[0] === 'orcid', 'Source is strictly ORCID');

  // 8. Integration Test: HTTP Server Endpoints
  console.log('\n-- 8. Helper Server HTTP Endpoints --');
  const { server } = require('./server');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const testPort = server.address().port;
  console.log(`Test helper server listening on ephemeral port ${testPort}`);

  // Test GET /health
  const healthRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
  });

  assert(healthRes.status === 200, 'GET /health returns 200 OK');
  assert(healthRes.body.status === 'ok', 'Health status is "ok"');
  assert(healthRes.body.host === '127.0.0.1', 'Helper confirms 127.0.0.1 host binding');

  // Test GET /api/enrich-doi without doi param
  const missingDoiRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${testPort}/api/enrich-doi`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
  });
  assert(missingDoiRes.status === 400, 'GET /api/enrich-doi returns 400 when doi missing');
  assert(!missingDoiRes.body.success, 'Response success is false');

  // Test invalid ORCID query
  const invalidQueryRes = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${testPort}/api/works?orcid=12345`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
  });

  assert(invalidQueryRes.status === 400, 'GET /api/works?orcid=12345 returns 400 Bad Request');
  assert(!invalidQueryRes.body.success, 'Response success is false');
  assert(invalidQueryRes.body.error.includes('Invalid ORCID format'), 'Validation error message returned');

  // Close server
  await new Promise((resolve) => server.close(resolve));
  assert(true, 'Test server shut down cleanly');

  console.log(`\n=== Helper Service Test Summary: ${passedTests} Passed, ${failedTests} Failed ===`);
  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner failure:', err);
  process.exit(1);
});

