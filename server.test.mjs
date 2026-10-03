import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeError,
  checkConfig,
  buildSignature,
  validateCreateProject,
  validateListProjects,
  handleCreateProject,
  handleListProjects,
  callApi,
  PROJECT_TYPES,
  LIST_PROJECT_TYPES,
  TEMPLATE_IDS,
  QUERY_TYPES,
} from './server.mjs';

function parseContent(result) {
  if (!result || !result.content || !result.content[0]) return null;
  return JSON.parse(result.content[0].text);
}

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

function setEnv(env = {}) {
  delete process.env.CODEARTS_REQ_ENDPOINT;
  delete process.env.CODEARTS_REQ_AK;
  delete process.env.CODEARTS_REQ_SK;
  delete process.env.CODEARTS_REQ_PROXY;
  Object.assign(process.env, env);
}

function mockFetchOnce(response) {
  globalThis.fetch = async () => response;
}

function mockFetchThrow(err) {
  globalThis.fetch = async () => {
    throw err;
  };
}

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  setEnv(ORIG_ENV);
});

describe('makeError', () => {
  test('返回结构化中文错误，isError 为 true', () => {
    const r = makeError('INVALID_ARGUMENTS', '参数非法', { field: 'project_name' });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].type, 'text');
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.error, true);
    assert.equal(payload.error_code, 'INVALID_ARGUMENTS');
    assert.equal(payload.error_msg, '参数非法');
    assert.equal(payload.field, 'project_name');
  });
});

describe('checkConfig', () => {
  test('缺 ENDPOINT 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_AK: 'ak', CODEARTS_REQ_SK: 'sk' });
    const r = checkConfig();
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'MISSING_CONFIG');
    assert.match(p.error_msg, /CODEARTS_REQ_ENDPOINT/);
  });

  test('缺 AK 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://example.com', CODEARTS_REQ_SK: 'sk' });
    const r = checkConfig();
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'MISSING_CONFIG');
    assert.match(p.error_msg, /CODEARTS_REQ_AK/);
  });

  test('缺 SK 返回 MISSING_CONFIG', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://example.com', CODEARTS_REQ_AK: 'ak' });
    const r = checkConfig();
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'MISSING_CONFIG');
    assert.match(p.error_msg, /CODEARTS_REQ_SK/);
  });

  test('配置齐全返回 null', () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://example.com', CODEARTS_REQ_AK: 'ak', CODEARTS_REQ_SK: 'sk' });
    assert.equal(checkConfig(), null);
  });
});

describe('validateCreateProject', () => {
  test('合法参数通过', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'scrum' }), []);
  });

  test('ipd + template_id 合法', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'ipd', template_id: '10001' }), []);
  });

  test('ipd + 数字 template_id 合法', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'ipd', template_id: 10001 }), []);
  });

  test('缺 project_name', () => {
    const e = validateCreateProject({ project_type: 'scrum' });
    assert.ok(e.length > 0);
    assert.match(e[0], /project_name/);
  });

  test('project_name 为空字符串', () => {
    const e = validateCreateProject({ project_name: '', project_type: 'scrum' });
    assert.ok(e.length > 0);
  });

  test('project_name 超过 128 字符', () => {
    const e = validateCreateProject({ project_name: 'x'.repeat(129), project_type: 'scrum' });
    assert.ok(e.length > 0);
  });

  test('project_type 非法', () => {
    const e = validateCreateProject({ project_name: 'p', project_type: 'unknown' });
    assert.ok(e.length > 0);
    assert.match(e[0], /project_type/);
  });

  test('project_type 缺失', () => {
    const e = validateCreateProject({ project_name: 'p' });
    assert.ok(e.length > 0);
  });

  test('source 超过 64 字符', () => {
    const e = validateCreateProject({ project_name: 'p', project_type: 'scrum', source: 'x'.repeat(65) });
    assert.ok(e.length > 0);
  });

  test('source 为空字符串合法', () => {
    assert.deepEqual(validateCreateProject({ project_name: 'p', project_type: 'scrum', source: '' }), []);
  });

  test('template_id 非法', () => {
    const e = validateCreateProject({ project_name: 'p', project_type: 'scrum', template_id: '99999' });
    assert.ok(e.length > 0);
  });

  test('ipd 缺 template_id', () => {
    const e = validateCreateProject({ project_name: 'p', project_type: 'ipd' });
    assert.ok(e.some((x) => x.includes('template_id')));
  });

  test('description 非字符串', () => {
    const e = validateCreateProject({ project_name: 'p', project_type: 'scrum', description: 123 });
    assert.ok(e.length > 0);
  });
});

describe('validateListProjects', () => {
  test('空参数合法（用默认值）', () => {
    assert.deepEqual(validateListProjects({}), []);
  });

  test('undefined 参数合法', () => {
    assert.deepEqual(validateListProjects(undefined), []);
  });

  test('offset 非 limit 倍数', () => {
    const e = validateListProjects({ offset: 5, limit: 10 });
    assert.ok(e.some((x) => x.includes('整数倍')));
  });

  test('offset 为 limit 倍数合法', () => {
    assert.deepEqual(validateListProjects({ offset: 20, limit: 10 }), []);
  });

  test('offset 超上限', () => {
    const e = validateListProjects({ offset: 10001, limit: 10 });
    assert.ok(e.length > 0);
  });

  test('limit 超上限', () => {
    const e = validateListProjects({ limit: 1001 });
    assert.ok(e.length > 0);
  });

  test('limit 为 0', () => {
    const e = validateListProjects({ limit: 0 });
    assert.ok(e.length > 0);
  });

  test('offset 非整数', () => {
    const e = validateListProjects({ offset: 1.5, limit: 10 });
    assert.ok(e.length > 0);
  });

  test('project_type 非法', () => {
    const e = validateListProjects({ project_type: 'ipd' });
    assert.ok(e.length > 0);
  });

  test('project_type 合法', () => {
    assert.deepEqual(validateListProjects({ project_type: 'scrum' }), []);
  });

  test('sort 合法', () => {
    assert.deepEqual(validateListProjects({ sort: 'project_name:asc' }), []);
  });

  test('sort 多组合法', () => {
    assert.deepEqual(validateListProjects({ sort: 'a:asc,b:desc,c:asc,d:desc' }), []);
  });

  test('sort 超 4 组', () => {
    const e = validateListProjects({ sort: 'a:asc,b:desc,c:asc,d:desc,e:asc' });
    assert.ok(e.some((x) => x.includes('4 组')));
  });

  test('sort 方向非法', () => {
    const e = validateListProjects({ sort: 'a:up' });
    assert.ok(e.some((x) => x.includes('格式非法')));
  });

  test('archive 非布尔', () => {
    const e = validateListProjects({ archive: 'yes' });
    assert.ok(e.length > 0);
  });

  test('query_type 非法', () => {
    const e = validateListProjects({ query_type: 'unknown' });
    assert.ok(e.length > 0);
  });

  test('全参数合法', () => {
    assert.deepEqual(
      validateListProjects({ offset: 0, limit: 10, search: 'kw', project_type: 'normal', sort: 'name:asc', archive: false, query_type: 'absent' }),
      [],
    );
  });
});

describe('handleCreateProject', () => {
  test('缺配置返回 MISSING_CONFIG', async () => {
    setEnv({});
    const r = await handleCreateProject({ project_name: 'p', project_type: 'scrum' });
    assert.equal(r.isError, true);
    assert.equal(parseContent(r).error_code, 'MISSING_CONFIG');
  });

  test('参数非法返回 INVALID_ARGUMENTS', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    const r = await handleCreateProject({ project_type: 'scrum' });
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'INVALID_ARGUMENTS');
    assert.match(p.error_msg, /project_name/);
  });

  test('API 成功返回提取字段', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        project_id: 'pid-1',
        project_num_id: 100,
        project_name: 'demo',
        project_type: 'scrum',
        user_num_id: 200,
        extra_field: 'ignored',
      }),
    });
    const r = await handleCreateProject({ project_name: 'demo', project_type: 'scrum' });
    assert.equal(r.isError, false);
    const p = parseContent(r);
    assert.equal(p.project_id, 'pid-1');
    assert.equal(p.project_num_id, 100);
    assert.equal(p.project_name, 'demo');
    assert.equal(p.project_type, 'scrum');
    assert.equal(p.user_num_id, 200);
    assert.equal(p.extra_field, undefined);
  });

  test('API 报错透传 error_code/error_msg/http_status', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: false,
      status: 401,
      json: async () => ({ error_code: 'Req.001', error_msg: '未授权' }),
    });
    const r = await handleCreateProject({ project_name: 'demo', project_type: 'scrum' });
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'Req.001');
    assert.equal(p.error_msg, '未授权');
    assert.equal(p.http_status, 401);
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchThrow(new TypeError('fetch failed'));
    const r = await handleCreateProject({ project_name: 'demo', project_type: 'scrum' });
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'NETWORK_ERROR');
    assert.match(p.error_msg, /fetch failed/);
  });

  test('ipd 时 template_id 传入 body', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    let capturedBody;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ project_id: '1' }) };
    };
    await handleCreateProject({ project_name: 'p', project_type: 'ipd', template_id: '10001' });
    assert.equal(capturedBody.template_id, '10001');
    assert.equal(capturedBody.project_type, 'ipd');
  });
});

describe('handleListProjects', () => {
  test('缺配置返回 MISSING_CONFIG', async () => {
    setEnv({});
    const r = await handleListProjects({});
    assert.equal(r.isError, true);
    assert.equal(parseContent(r).error_code, 'MISSING_CONFIG');
  });

  test('参数非法返回 INVALID_ARGUMENTS', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    const r = await handleListProjects({ offset: 5, limit: 10 });
    assert.equal(r.isError, true);
    assert.equal(parseContent(r).error_code, 'INVALID_ARGUMENTS');
  });

  test('API 成功返回 projects 与 total', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ projects: [{ id: 1 }, { id: 2 }], total: 2, extra: 'x' }),
    });
    const r = await handleListProjects({});
    assert.equal(r.isError, false);
    const p = parseContent(r);
    assert.deepEqual(p.projects, [{ id: 1 }, { id: 2 }]);
    assert.equal(p.total, 2);
  });

  test('API 报错透传', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => ({ error_code: 'internal', error_msg: '内部错误' }),
    });
    const r = await handleListProjects({});
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'internal');
    assert.equal(p.http_status, 500);
  });

  test('网络异常返回 NETWORK_ERROR', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchThrow(new Error('connection reset'));
    const r = await handleListProjects({});
    assert.equal(r.isError, true);
    assert.equal(parseContent(r).error_code, 'NETWORK_ERROR');
  });

  test('query 参数正确拼接', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({ projects: [], total: 0 }) };
    };
    await handleListProjects({ offset: 0, limit: 20, search: 'kw', project_type: 'scrum' });
    const u = new URL(capturedUrl);
    assert.equal(u.searchParams.get('offset'), '0');
    assert.equal(u.searchParams.get('limit'), '20');
    assert.equal(u.searchParams.get('search'), 'kw');
    assert.equal(u.searchParams.get('project_type'), 'scrum');
  });

  test('请求头携带 Authorization 签名与 X-Sdk-Date', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'my-ak', CODEARTS_REQ_SK: 'my-sk' });
    let capturedHeaders;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => ({ projects: [], total: 0 }) };
    };
    await handleListProjects({});
    assert.match(capturedHeaders['Authorization'], /^SDK-HMAC-SHA256 Access=my-ak, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]+$/);
    assert.match(capturedHeaders['X-Sdk-Date'], /^\d{8}T\d{6}Z$/);
    assert.equal(capturedHeaders['X-Auth-Token'], undefined);
  });
});

describe('buildSignature', () => {
  test('GET 请求生成合法签名头', () => {
    const { authorization, xSdkDate } = buildSignature({
      method: 'GET',
      url: 'https://projectman-ext.cn-north-4.myhuaweicloud.com/v4/projects?limit=10&offset=0',
      ak: 'HPUA1HOZVWWBGMPPVKOA',
      sk: 'test-secret-key',
      body: '',
    });
    assert.match(authorization, /^SDK-HMAC-SHA256 Access=HPUA1HOZVWWBGMPPVKOA, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]{64}$/);
    assert.match(xSdkDate, /^\d{8}T\d{6}Z$/);
  });

  test('POST 请求 body 参与签名', () => {
    const sig1 = buildSignature({
      method: 'POST',
      url: 'https://x.com/v4/project',
      ak: 'ak', sk: 'sk',
      body: '{"project_name":"a"}',
    });
    const sig2 = buildSignature({
      method: 'POST',
      url: 'https://x.com/v4/project',
      ak: 'ak', sk: 'sk',
      body: '{"project_name":"b"}',
    });
    assert.notEqual(sig1.authorization, sig2.authorization);
  });

  test('不同 SK 产生不同签名', () => {
    const sig1 = buildSignature({ method: 'GET', url: 'https://x.com/v4/projects', ak: 'ak', sk: 'sk1', body: '' });
    const sig2 = buildSignature({ method: 'GET', url: 'https://x.com/v4/projects', ak: 'ak', sk: 'sk2', body: '' });
    assert.notEqual(sig1.authorization, sig2.authorization);
  });

  test('query 参数顺序不影响签名', () => {
    const sig1 = buildSignature({ method: 'GET', url: 'https://x.com/v4/projects?limit=10&offset=0', ak: 'ak', sk: 'sk', body: '' });
    const sig2 = buildSignature({ method: 'GET', url: 'https://x.com/v4/projects?offset=0&limit=10', ak: 'ak', sk: 'sk', body: '' });
    assert.equal(sig1.authorization, sig2.authorization);
  });

  test('canonicalURI 无尾斜杠时补齐（该 endpoint 验签要求）', () => {
    const s = buildSignature({ method: 'POST', url: 'https://x.com/v4/project', ak: 'ak', sk: 'sk', body: '' });
    assert.ok(s.canonicalRequest.startsWith('POST\n/v4/project/\n'));
  });

  test('非标准端口包含在签名 host 中', () => {
    const s1 = buildSignature({ method: 'GET', url: 'http://127.0.0.1:8080/v4/projects', ak: 'ak', sk: 'sk', body: '' });
    const s2 = buildSignature({ method: 'GET', url: 'http://127.0.0.1:8081/v4/projects', ak: 'ak', sk: 'sk', body: '' });
    assert.notEqual(s1.authorization, s2.authorization);
    assert.match(s1.authorization, /^SDK-HMAC-SHA256 Access=ak, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]{64}$/);
  });

  test('query 特殊字符按 RFC3986 转义参与签名', () => {
    const s = buildSignature({ method: 'GET', url: 'https://x.com/v4/projects?search=a*b c', ak: 'ak', sk: 'sk', body: '' });
    assert.ok(s.canonicalQueryString.includes('search=a%2Ab%20c'));
  });
});

describe('callApi', () => {
  test('endpoint 末尾斜杠被规整', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com/', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await callApi('GET', '/v4/projects');
    assert.equal(capturedUrl, 'https://x.com/v4/projects');
  });

  test('响应体解析失败返回 NETWORK_ERROR', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const r = await callApi('GET', '/v4/projects');
    assert.equal(r.isError, true);
    assert.equal(parseContent(r).error_code, 'NETWORK_ERROR');
  });

  test('HTTP 错误且无 error_code 时用 HTTP_status 兜底', async () => {
    setEnv({ CODEARTS_REQ_ENDPOINT: 'https://x.com', CODEARTS_REQ_AK: 'test-ak', CODEARTS_REQ_SK: 'test-sk' });
    mockFetchOnce({
      ok: false,
      status: 503,
      json: async () => ({ msg: 'unavailable' }),
    });
    const r = await callApi('GET', '/v4/projects');
    assert.equal(r.isError, true);
    const p = parseContent(r);
    assert.equal(p.error_code, 'HTTP_503');
    assert.equal(p.http_status, 503);
  });
});

describe('常量', () => {
  test('PROJECT_TYPES 包含全部类型', () => {
    assert.deepEqual(PROJECT_TYPES, ['scrum', 'normal', 'xboard', 'basic', 'phoenix', 'ipd']);
  });
  test('LIST_PROJECT_TYPES 仅三种', () => {
    assert.deepEqual(LIST_PROJECT_TYPES, ['scrum', 'normal', 'xboard']);
  });
  test('TEMPLATE_IDS 三种', () => {
    assert.deepEqual(TEMPLATE_IDS, ['10001', '10002', '10003']);
  });
  test('QUERY_TYPES 两种', () => {
    assert.deepEqual(QUERY_TYPES, ['domain_projects', 'absent']);
  });
});