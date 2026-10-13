import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(root, 'data');
const corpusFile = path.join(dataDir, 'corpus.json');

const API = 'https://api.zhihu.com/km-indep-home/hackathon/v2';
const LIST_TTL = 30 * 60 * 1000;
const DETAIL_TTL = 6 * 60 * 60 * 1000;
const MAX_ITEMS = 400;

const memory = {
  lists: { story: null, knowledge: null },
  details: {},
  lastError: null
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function safeWorkId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!SAFE_ID.test(raw)) return null;
  return raw;
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs || 9000)
  });
  if (!response.ok) {
    const error = new Error('zhihu_http_' + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function pickString(value, max) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return raw.slice(0, max);
}

function normalizeItem(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const workId = safeWorkId(raw.work_id);
  if (!workId) return null;
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(function (label) { return pickString(label, 24); }).filter(Boolean).slice(0, 12)
    : [];
  return {
    kind: kind,
    workId: workId,
    title: pickString(raw.title || raw.chapter_name, 160) || '未命名内容',
    description: pickString(raw.description || raw.introduction, 600),
    artwork: pickString(raw.artwork || raw.tab_artwork, 400),
    labels: labels,
    url: 'https://www.zhihu.com/' + (kind === 'story' ? 'story' : 'knowledge') + '/' + workId
  };
}

async function loadDisk() {
  try {
    const parsed = JSON.parse(await fs.readFile(corpusFile, 'utf8'));
    if (parsed && parsed.lists) {
      memory.lists.story = parsed.lists.story || null;
      memory.lists.knowledge = parsed.lists.knowledge || null;
      memory.details = parsed.details || {};
    }
  } catch {
    /* first run: no cached corpus yet */
  }
}

async function saveDisk() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const payload = {
      savedAt: new Date().toISOString(),
      lists: { story: memory.lists.story, knowledge: memory.lists.knowledge },
      details: memory.details
    };
    const temporary = corpusFile + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
    await fs.rename(temporary, corpusFile);
  } catch {
    /* cache write failure must never break a request */
  }
}

async function refreshList(kind, force) {
  const cached = memory.lists[kind];
  const fresh = cached && Date.now() - cached.fetchedAt < LIST_TTL;
  if (fresh && !force) return cached.items;
  try {
    const data = await fetchJson(API + '/' + kind + '/list', 9000);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    const items = list.map(function (raw) { return normalizeItem(raw, kind); }).filter(Boolean).slice(0, MAX_ITEMS);
    if (items.length) {
      memory.lists[kind] = { fetchedAt: Date.now(), items: items, live: true };
      await saveDisk();
      return items;
    }
    throw new Error('empty_list');
  } catch (error) {
    memory.lastError = { at: new Date().toISOString(), kind: kind, message: String(error.message || error) };
    if (cached && cached.items && cached.items.length) return cached.items;
    return [];
  }
}

export async function hydrate() {
  await loadDisk();
}

export async function getCorpus(options) {
  const force = Boolean(options && options.force);
  const stories = await refreshList('story', force);
  const knowledge = await refreshList('knowledge', force);
  const docs = stories.concat(knowledge);
  const fetchedAt = Math.max(
    memory.lists.story ? memory.lists.story.fetchedAt : 0,
    memory.lists.knowledge ? memory.lists.knowledge.fetchedAt : 0
  );
  return { docs: docs, fetchedAt: fetchedAt, stale: !fetchedAt || Date.now() - fetchedAt > LIST_TTL };
}

export async function getDetail(kind, workId) {
  const id = safeWorkId(workId);
  if (!id) throw new Error('invalid_work_id');
  if (kind !== 'story' && kind !== 'knowledge') throw new Error('invalid_kind');
  const bucket = memory.details[kind] || (memory.details[kind] = {});
  const cached = bucket[id];
  if (cached && Date.now() - cached.fetchedAt < DETAIL_TTL) return cached.data;
  try {
    const data = await fetchJson(API + '/' + kind + '/' + id, 9000);
    const clean = {
      workId: id,
      kind: kind,
      title: pickString(data.chapter_name || data.title, 160),
      authorName: pickString(data.author_name, 80),
      authorAvatar: pickString(data.author_avatar, 400),
      labels: Array.isArray(data.labels) ? data.labels.map(function (label) { return pickString(label, 24); }).filter(Boolean).slice(0, 12) : [],
      introduction: pickString(data.introduction, 600),
      content: pickString(data.content, 20000)
    };
    bucket[id] = { fetchedAt: Date.now(), data: clean };
    await saveDisk();
    return clean;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}

export function corpusStatus() {
  const count = function (kind) { return memory.lists[kind] && memory.lists[kind].items ? memory.lists[kind].items.length : 0; };
  const detailCount = Object.keys(memory.details.story || {}).length + Object.keys(memory.details.knowledge || {}).length;
  return {
    story: count('story'),
    knowledge: count('knowledge'),
    details: detailCount,
    fetchedAt: memory.lists.story ? new Date(memory.lists.story.fetchedAt).toISOString() : null,
    lastError: memory.lastError
  };
}

export function resetMemory() {
  memory.lists.story = null;
  memory.lists.knowledge = null;
  memory.details = {};
}
