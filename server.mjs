#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const PROJECT_TYPES = ['scrum', 'normal', 'xboard', 'basic', 'phoenix', 'ipd'];
const LIST_PROJECT_TYPES = ['scrum', 'normal', 'xboard'];
const TEMPLATE_IDS = ['10001', '10002', '10003'];
const QUERY_TYPES = ['domain_projects', 'absent'];

function makeError(error_code, error_msg, extra = {}) {
  const payload = { error: true, error_code, error_msg, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSHA256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

function formatSdkDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

function rfc3986Encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildSignature({ method, url, ak, sk, body = '' }) {
  const u = new URL(url);
  const host = u.port && u.port !== '80' && u.port !== '443' ? `${u.hostname}:${u.port}` : u.hostname;
  const xSdkDate = formatSdkDate();

  let canonicalURI = u.pathname || '/';
  if (!canonicalURI.endsWith('/')) canonicalURI += '/';
  const params = new URLSearchParams(u.search);
  const sortedKeys = [...params.keys()].sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params.get(k))}`)
    .join('&');

  const signedHeaders = 'host;x-sdk-date';
  const canonicalHeaders = `host:${host}\nx-sdk-date:${xSdkDate}\n`;
  const hashedPayload = sha256Hex(body);

  const canonicalRequest = [
    method,
    canonicalURI,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `SDK-HMAC-SHA256\n${xSdkDate}\n${hashedCanonicalRequest}`;
  const signature = hmacSHA256Hex(sk, stringToSign);
  const authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, xSdkDate, canonicalRequest, canonicalQueryString };
}

function getConfig() {
  return {
    endpoint: process.env.CODEARTS_REQ_ENDPOINT,
    ak: process.env.CODEARTS_REQ_AK,
    sk: process.env.CODEARTS_REQ_SK,
  };
}

function socks5Connect(proxyHost, proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost);
    let stage = 0;
    socket.on('error', reject);
    socket.on('data', (data) => {
      if (stage === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) { reject(new Error('socks5 握手失败')); return; }
        stage = 1;
        const h = Buffer.from(targetHost);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]));
      } else if (stage === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x00) { reject(new Error('socks5 连接失败 rep=' + data[1])); return; }
        socket.removeAllListeners('data');
        const tlsSock = tls.connect({ socket, servername: targetHost, ALPNProtocols: ['http/1.1'] });
        tlsSock.on('secureConnect', () => resolve(tlsSock));
        tlsSock.on('error', reject);
      }
    });
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

function decodeChunked(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) break;
    const size = parseInt(buf.slice(pos, lineEnd).toString(), 16);
    if (size === 0) break;
    pos = lineEnd + 2;
    out.push(buf.slice(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(out).toString('utf8');
}

function createProxyFetch(proxyStr) {
  const m = /^socks5?:\/\/([^:]+):(\d+)$/.exec(proxyStr);
  if (!m) throw new Error(`不支持的代理格式：${proxyStr}`);
  const proxy = { host: m[1], port: Number(m[2]) };
  return async (url, init) => {
    const u = new URL(url);
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;
    const bodyBuf = init.body ? Buffer.from(init.body, 'utf8') : Buffer.alloc(0);
    const sock = await socks5Connect(proxy.host, proxy.port, u.hostname, u.port ? Number(u.port) : 443);
    return new Promise((resolve, reject) => {
      const reqLines = [`${init.method || 'GET'} ${u.pathname + u.search} HTTP/1.1`, `Host: ${u.hostname}`];
      for (const [k, v] of Object.entries(headers)) reqLines.push(`${k}: ${v}`);
      reqLines.push(`Content-Length: ${bodyBuf.length}`, 'Connection: close', '', '');
      sock.write(reqLines.join('\r\n'));
      if (bodyBuf.length) sock.write(bodyBuf);
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => {
        const raw = Buffer.concat(chunks);
        const sep = raw.indexOf('\r\n\r\n');
        const headerStr = raw.slice(0, sep).toString('utf8');
        const bodyRaw = raw.slice(sep + 4);
        const [statusLine, ...hdrLines] = headerStr.split('\r\n');
        const status = parseInt(statusLine.split(' ')[1]);
        const respHeaders = {};
        for (const l of hdrLines) { const i = l.indexOf(':'); if (i > 0) respHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
        const bodyStr = respHeaders['transfer-encoding']?.includes('chunked') ? decodeChunked(bodyRaw) : bodyRaw.toString('utf8');
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(bodyStr) });
      });
      sock.on('error', reject);
    });
  };
}

function checkConfig() {
  const { endpoint, ak, sk } = getConfig();
  if (!endpoint) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_ENDPOINT，请先配置华为云 CodeArts Req 终端节点');
  }
  if (!ak) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_AK，请先配置华为云访问密钥 AK');
  }
  if (!sk) {
    return makeError('MISSING_CONFIG', '缺少环境变量 CODEARTS_REQ_SK，请先配置华为云访问密钥 SK');
  }
  return null;
}

function validateCreateProject(args) {
  const errors = [];
  const { project_name, project_type, description, enterprise_id, source, template_id } = args || {};

  if (typeof project_name !== 'string' || project_name.length < 1 || project_name.length > 128) {
    errors.push('project_name 必填，且为 1-128 字符的字符串');
  }
  if (!PROJECT_TYPES.includes(project_type)) {
    errors.push(`project_type 必填，且为以下之一：${PROJECT_TYPES.join(' / ')}`);
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description 选填，但必须为字符串');
  }
  if (enterprise_id !== undefined && typeof enterprise_id !== 'string') {
    errors.push('enterprise_id 选填，但必须为字符串');
  }
  if (source !== undefined) {
    if (typeof source !== 'string' || source.length > 64) {
      errors.push('source 选填，且为 0-64 字符的字符串');
    }
  }
  if (template_id !== undefined && !TEMPLATE_IDS.includes(String(template_id))) {
    errors.push(`template_id 选填，且为以下之一：${TEMPLATE_IDS.join(' / ')}`);
  }
  if (project_type === 'ipd' && (template_id === undefined || template_id === null || template_id === '')) {
    errors.push('当 project_type = ipd 时，template_id 必传');
  }
  return errors;
}

function validateListProjects(args) {
  const errors = [];
  const { offset, limit, search, project_type, sort, archive, query_type } = args || {};

  const off = offset === undefined ? 0 : offset;
  const lim = limit === undefined ? 10 : limit;

  if (!Number.isInteger(off) || off < 0 || off > 10000) {
    errors.push('offset 选填，整数，范围 0-10000，默认 0');
  } else if (!Number.isInteger(lim) || lim < 1) {
    // limit 非法时不校验倍数，由 limit 自身校验报错
  } else if (off % lim !== 0) {
    errors.push('offset 必须为 limit 的整数倍');
  }
  if (!Number.isInteger(lim) || lim < 1 || lim > 1000) {
    errors.push('limit 选填，整数，范围 1-1000，默认 10');
  }
  if (search !== undefined && typeof search !== 'string') {
    errors.push('search 选填，但必须为字符串');
  }
  if (project_type !== undefined && !LIST_PROJECT_TYPES.includes(project_type)) {
    errors.push(`project_type 选填，且为以下之一：${LIST_PROJECT_TYPES.join(' / ')}`);
  }
  if (sort !== undefined) {
    if (typeof sort !== 'string') {
      errors.push('sort 选填，但必须为字符串，格式 字段:方向，多组用逗号分隔，最多 4 组');
    } else {
      const groups = sort.split(',').map((g) => g.trim()).filter(Boolean);
      if (groups.length > 4) {
        errors.push('sort 最多 4 组');
      } else {
        for (const g of groups) {
          if (!/^[^:]+:(asc|desc)$/i.test(g)) {
            errors.push(`sort 格式非法：「${g}」，应为 字段:asc 或 字段:desc`);
            break;
          }
        }
      }
    }
  }
  if (archive !== undefined && typeof archive !== 'boolean') {
    errors.push('archive 选填，但必须为布尔值');
  }
  if (query_type !== undefined && !QUERY_TYPES.includes(query_type)) {
    errors.push(`query_type 选填，且为以下之一：${QUERY_TYPES.join(' / ')}`);
  }
  return errors;
}

async function callApi(method, path, { query, body } = {}) {
  const { endpoint, ak, sk } = getConfig();
  let url = endpoint.replace(/\/$/, '') + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        params.append(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += '?' + qs;
  }

  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const { authorization, xSdkDate } = buildSignature({ method, url, ak, sk, body: bodyStr });


  const options = {
    method,
    headers: {
      'Authorization': authorization,
      'X-Sdk-Date': xSdkDate,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    options.body = bodyStr;
  }

  let resp;
  try {
    const proxyStr = process.env.CODEARTS_REQ_PROXY;
    const fetchFn = proxyStr ? createProxyFetch(proxyStr) : fetch;
    resp = await fetchFn(url, options);
  } catch (e) {
    return makeError('NETWORK_ERROR', `网络请求失败：${e.message}`, { url });
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return makeError('NETWORK_ERROR', `解析响应体失败：${e.message}`, { http_status: resp.status, url });
  }

  if (!resp.ok) {
    return makeError(
      data?.error_code || `HTTP_${resp.status}`,
      data?.error_msg || `API 返回 HTTP ${resp.status}`,
      { http_status: resp.status, api_response: data },
    );
  }

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false, _raw: data };
}

async function handleCreateProject(args) {
  const configErr = checkConfig();
  if (configErr) return configErr;

  const errors = validateCreateProject(args);
  if (errors.length > 0) {
    return makeError('INVALID_ARGUMENTS', `参数校验失败：\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  }

  const { project_name, project_type, description, enterprise_id, source, template_id } = args;
  const body = { project_name, project_type };
  if (description !== undefined) body.description = description;
  if (enterprise_id !== undefined) body.enterprise_id = enterprise_id;
  if (source !== undefined) body.source = source;
  if (template_id !== undefined) body.template_id = String(template_id);

  const result = await callApi('POST', '/v4/project', { body });
  if (result.isError) return result;

  const data = result._raw;
  const picked = {};
  for (const k of ['project_id', 'project_num_id', 'project_name', 'project_type', 'user_num_id']) {
    if (data && data[k] !== undefined) picked[k] = data[k];
  }
  const out = Object.keys(picked).length > 0 ? picked : data;

  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false };
}

async function handleListProjects(args) {
  const configErr = checkConfig();
  if (configErr) return configErr;

  const errors = validateListProjects(args);
  if (errors.length > 0) {
    return makeError('INVALID_ARGUMENTS', `参数校验失败：\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  }

  const { offset, limit, search, project_type, sort, archive, query_type } = args || {};
  const query = {
    offset: offset === undefined ? 0 : offset,
    limit: limit === undefined ? 10 : limit,
  };
  if (search !== undefined) query.search = search;
  if (project_type !== undefined) query.project_type = project_type;
  if (sort !== undefined) query.sort = sort;
  if (archive !== undefined) query.archive = archive;
  if (query_type !== undefined) query.query_type = query_type;

  const result = await callApi('GET', '/v4/projects', { query });
  if (result.isError) return result;

  const data = result._raw;
  const out = {
    projects: Array.isArray(data?.projects) ? data.projects : [],
    total: typeof data?.total === 'number' ? data.total : (Array.isArray(data?.projects) ? data.projects.length : 0),
  };

  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false };
}

const server = new Server(
  { name: 'codearts-req', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_project',
      description: '创建 CodeArts 需求管理项目（POST /v4/project）',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string', minLength: 1, maxLength: 128, description: '项目名称（必填，1-128 字符）' },
          project_type: { type: 'string', enum: PROJECT_TYPES, description: '项目类型（必填）' },
          description: { type: 'string', description: '项目描述（选填）' },
          enterprise_id: { type: 'string', description: '企业项目 ID（选填）' },
          source: { type: 'string', maxLength: 64, description: '来源（选填，0-64 字符）' },
          template_id: { type: 'string', enum: TEMPLATE_IDS, description: '模板 ID（选填，project_type=ipd 时必传）' },
        },
        required: ['project_name', 'project_type'],
      },
    },
    {
      name: 'list_projects',
      description: '查询 CodeArts 需求管理项目列表（GET /v4/projects）',
      inputSchema: {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0, description: '偏移量（选填，默认 0，须为 limit 整数倍）' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 10, description: '每页数量（选填，默认 10）' },
          search: { type: 'string', description: '搜索关键字（选填）' },
          project_type: { type: 'string', enum: LIST_PROJECT_TYPES, description: '项目类型（选填）' },
          sort: { type: 'string', description: '排序，格式 字段:方向，多组逗号分隔，最多 4 组（选填）' },
          archive: { type: 'boolean', description: '是否归档（选填）' },
          query_type: { type: 'string', enum: QUERY_TYPES, description: '查询类型（选填）' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'create_project':
      return await handleCreateProject(args);
    case 'list_projects':
      return await handleListProjects(args);
    default:
      return makeError('INVALID_ARGUMENTS', `未知工具：${name}`);
  }
});

async function main() {
  const missing = ['CODEARTS_REQ_ENDPOINT', 'CODEARTS_REQ_AK', 'CODEARTS_REQ_SK'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[codearts-req] 警告：未检测到环境变量 ${missing.join('、')}，工具调用时将返回 MISSING_CONFIG`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[codearts-req] MCP Server 已启动（stdio）');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((e) => {
    console.error('MCP Server 启动失败：', e);
    process.exit(1);
  });
}

export {
  makeError,
  getConfig,
  checkConfig,
  buildSignature,
  sha256Hex,
  hmacSHA256Hex,
  formatSdkDate,
  validateCreateProject,
  validateListProjects,
  callApi,
  handleCreateProject,
  handleListProjects,
  PROJECT_TYPES,
  LIST_PROJECT_TYPES,
  TEMPLATE_IDS,
  QUERY_TYPES,
};