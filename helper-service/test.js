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

  // 5. Integration Test: HTTP Server Endpoints
  console.log('\n-- 5. Helper Server HTTP Endpoints --');
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

