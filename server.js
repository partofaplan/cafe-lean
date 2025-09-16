const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Config
const PORT = process.env.PORT || 3000;
const DEFAULT_CREATE_MIN = parseInt(process.env.DEFAULT_CREATE_MIN || '5', 10);
const DEFAULT_VOTING_MIN = parseInt(process.env.DEFAULT_VOTING_MIN || '3', 10);
const DEFAULT_DISCUSS_MIN = parseInt(process.env.DEFAULT_DISCUSS_MIN || '5', 10);
const ID = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);
const TOPIC_ID = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);
const DEFAULT_MAX_VOTES_PER_PARTICIPANT = parseInt(process.env.MAX_VOTES || '3', 10);

// In-memory store (MVP)
// meetings: { [meetingId]: { id, adminToken, topics: Topic[], participants: Set<string>, votesByParticipant: Map<participantId, VoteRecord> } }
const meetings = new Map();

function normalizeVoteRecordValue(value) {
  if (!value) return { total: 0, topics: new Map() };
  if (value instanceof Map) {
    // Map of topic -> count but no total yet
    const total = Array.from(value.values()).reduce((acc, n) => acc + (Number(n) || 0), 0);
    return { total, topics: new Map(value) };
  }
  if (value instanceof Set) {
    const topics = new Map();
    for (const topicId of value) {
      topics.set(topicId, (topics.get(topicId) || 0) + 1);
    }
    return { total: value.size, topics };
  }
  if (Array.isArray(value?.topics)) {
    const topics = new Map();
    for (const [topicId, count] of value.topics) {
      const n = Number(count) || 0;
      if (n > 0 && typeof topicId === 'string') {
        topics.set(topicId, n);
      }
    }
    const total = Number(value.total);
    const sum = Array.from(topics.values()).reduce((acc, n) => acc + n, 0);
    return { total: Number.isFinite(total) ? total : sum, topics };
  }
  if (value && typeof value === 'object' && value.topics && typeof value.topics === 'object') {
    const topics = new Map();
    for (const key of Object.keys(value.topics)) {
      const n = Number(value.topics[key]) || 0;
      if (n > 0) topics.set(key, n);
    }
    const total = Number(value.total);
    const sum = Array.from(topics.values()).reduce((acc, n) => acc + n, 0);
    return { total: Number.isFinite(total) ? total : sum, topics };
  }
  if (Array.isArray(value)) {
    const topics = new Map();
    for (const topicId of value) {
      if (typeof topicId === 'string') {
        topics.set(topicId, (topics.get(topicId) || 0) + 1);
      }
    }
    return { total: value.length, topics };
  }
  const total = Number(value.total);
  if (value.topics instanceof Map) {
    const sum = Array.from(value.topics.values()).reduce((acc, n) => acc + (Number(n) || 0), 0);
    return { total: Number.isFinite(total) ? total : sum, topics: new Map(value.topics) };
  }
  return { total: Number.isFinite(total) ? total : 0, topics: new Map() };
}

function normalizeParticipantVotes(meeting, participantId) {
  if (!participantId) return null;
  const existing = meeting.votesByParticipant.get(participantId);
  if (!existing) return null;
  const normalized = normalizeVoteRecordValue(existing);
  meeting.votesByParticipant.set(participantId, normalized);
  return normalized;
}

function ensureParticipantVotes(meeting, participantId) {
  if (!participantId) return { total: 0, topics: new Map() };
  const existing = normalizeParticipantVotes(meeting, participantId);
  if (existing) return existing;
  const created = { total: 0, topics: new Map() };
  meeting.votesByParticipant.set(participantId, created);
  return created;
}

function votesRecordToPlainObject(record) {
  if (!record) return {};
  if (record.topics instanceof Map) {
    return Object.fromEntries(record.topics.entries());
  }
  if (Array.isArray(record.topics)) {
    const out = {};
    for (const [topicId, count] of record.topics) {
      const n = Number(count) || 0;
      if (n > 0 && typeof topicId === 'string') out[topicId] = n;
    }
    return out;
  }
  if (record.topics && typeof record.topics === 'object') {
    const out = {};
    for (const key of Object.keys(record.topics)) {
      const n = Number(record.topics[key]) || 0;
      if (n > 0) out[key] = n;
    }
    return out;
  }
  return {};
}

/**
 * Topic shape:
 * { id, title, authorId, votes: number, voters: Map<participantId, number>, column: 'todo'|'doing'|'done', createdAt }
 */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Minimal cookie parser
function parseCookie(str) {
  const out = {};
  if (!str) return out;
  str.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i === -1) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

// Simple landing page to create/join
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Lightweight health endpoint for Cloud Run or probes
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// Create a meeting
app.post('/api/create', (req, res) => {
  const meetingId = ID();
  const adminToken = ID() + ID(); // 12 chars
  const meeting = {
    id: meetingId,
    adminToken,
    topics: [],
    participants: new Set(),
    votesByParticipant: new Map(),
    maxVotesPerParticipant: DEFAULT_MAX_VOTES_PER_PARTICIPANT,
    durations: { create: DEFAULT_CREATE_MIN, voting: DEFAULT_VOTING_MIN, discuss: DEFAULT_DISCUSS_MIN }, // minutes
    phase: null, // 'create' | 'voting' | 'discuss' | null
    phaseEndsAt: null,
    phasePaused: false,
    phaseRemainingMs: null,
    currentTopicId: null,
    createdAt: Date.now(),
  };
  meetings.set(meetingId, meeting);
  persist();
  res.json({
    meetingId,
    adminToken,
    boardUrl: `/board/${meetingId}`,
    joinUrl: `/join/${meetingId}`,
    adminUrl: `/admin/${meetingId}`,
  });
});

// Create a meeting with a user-provided ID
app.post('/api/create-with-id', (req, res) => {
  let raw = (req.body.meetingId || '').toString();
  // Normalize: uppercase alphanumeric only
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized || normalized.length < 4 || normalized.length > 12) {
    return res.status(400).json({ error: 'Code must be 4-12 letters/numbers' });
  }
  if (meetings.has(normalized)) {
    return res.status(409).json({ error: 'Meeting code already exists' });
  }
  const adminToken = ID() + ID();
  const meeting = {
    id: normalized,
    adminToken,
    topics: [],
    participants: new Set(),
    votesByParticipant: new Map(),
    maxVotesPerParticipant: DEFAULT_MAX_VOTES_PER_PARTICIPANT,
    durations: { create: DEFAULT_CREATE_MIN, voting: DEFAULT_VOTING_MIN, discuss: DEFAULT_DISCUSS_MIN },
    phase: null,
    phaseEndsAt: null,
    phasePaused: false,
    phaseRemainingMs: null,
    currentTopicId: null,
    createdAt: Date.now(),
  };
  meetings.set(normalized, meeting);
  persist();
  res.json({
    meetingId: normalized,
    adminToken,
    boardUrl: `/board/${normalized}`,
    joinUrl: `/join/${normalized}`,
    adminUrl: `/admin/${normalized}`,
  });
});

// Basic route guards to ensure meeting exists
app.get(['/board/:id', '/admin/:id', '/join/:id', '/setup/:id'], (req, res, next) => {
  const id = req.params.id.toUpperCase();
  if (!meetings.has(id)) {
    return res.redirect(`/?missing=${id}`);
  }
  next();
});

app.get('/board/:id', (req, res) => {
  res.sendFile(__dirname + '/public/board.html');
});
app.get('/admin/:id', (req, res) => {
  res.sendFile(__dirname + '/public/admin.html');
});
app.get('/setup/:id', (req, res) => {
  res.sendFile(__dirname + '/public/setup.html');
});
app.get('/join/:id', (req, res) => {
  const id = (req.params.id || '').toUpperCase();
  const cookieName = `clid_${id}`;
  const cookies = parseCookie(req.headers.cookie || '');
  if (!cookies[cookieName]) {
    const pid = TOPIC_ID();
    const cookie = `${cookieName}=${encodeURIComponent(pid)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    res.setHeader('Set-Cookie', cookie);
  }
  res.sendFile(__dirname + '/public/join.html');
});

function meetingStateForClient(meeting) {
  const totalVotesCast = Array.from(meeting.votesByParticipant.values()).reduce((acc, rec) => {
    if (!rec) return acc;
    if (rec.total != null) return acc + rec.total;
    if (rec.size != null) return acc + rec.size; // legacy set support
    return acc;
  }, 0);
  return {
    id: meeting.id,
    topics: meeting.topics.map(t => ({
      id: t.id,
      title: t.title,
      votes: t.votes,
      column: t.column,
      createdAt: t.createdAt,
    })),
    // Provide only counts for privacy
    totals: {
      participants: meeting.participants.size,
      votesCast: totalVotesCast,
    },
    config: { maxVotesPerParticipant: meeting.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT },
    phase: meeting.phase,
    phaseEndsAt: meeting.phaseEndsAt,
    phasePaused: meeting.phasePaused,
    phaseRemainingMs: meeting.phaseRemainingMs,
    now: Date.now(),
    durations: meeting.durations,
    currentTopicId: meeting.currentTopicId,
  };
}

io.on('connection', (socket) => {
  let joinedMeetingId = null;
  let participantId = null;
  let isAdmin = false;

  // Client joins a meeting room
  socket.on('join', ({ meetingId, role, id, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) {
      socket.emit('error_msg', 'Meeting not found');
      return;
    }
    joinedMeetingId = mid;
    // Prefer server-issued cookie per meeting for participant identity
    const cookies = parseCookie(socket.handshake?.headers?.cookie || '');
    const cookiePid = cookies[`clid_${mid}`];
    participantId = role === 'participant' ? (cookiePid || id || socket.id) : (id || socket.id);
    isAdmin = role === 'admin' && adminToken === meeting.adminToken;
    meeting.participants.add(participantId);
    socket.join(mid);
    socket.emit('state', meetingStateForClient(meeting));
    if (role === 'participant') {
      const yourVotes = normalizeParticipantVotes(meeting, participantId);
      socket.emit('your_votes', {
        topicCounts: votesRecordToPlainObject(yourVotes),
        max: meeting.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT,
      });
    }
  });

  socket.on('submit_topic', ({ meetingId, title, authorId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting || !title || !authorId) return;
    if (meeting.phase && meeting.phase !== 'create') return; // only during create phase
    const topic = {
      id: TOPIC_ID(),
      title: String(title).slice(0, 200),
      authorId,
      votes: 0,
      voters: new Map(),
      column: 'todo',
      createdAt: Date.now(),
    };
    meeting.topics.push(topic);
    io.to(mid).emit('state', meetingStateForClient(meeting));
    io.to(mid).emit('topic_added', { topicId: topic.id });
    persist();
  });

  socket.on('vote', ({ meetingId, participantId: pid, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    if (meeting.phase !== 'voting') return; // only during voting phase
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    // Use server-known participant if available
    const actualPid = (joinedMeetingId === mid && participantId) ? participantId : pid;
    const record = ensureParticipantVotes(meeting, actualPid);
    const maxVotes = meeting.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT;
    if (record.total >= maxVotes) return; // limit reached

    const currentCount = record.topics.get(topicId) || 0;
    record.topics.set(topicId, currentCount + 1);
    record.total += 1;
    meeting.votesByParticipant.set(actualPid, record);
    topic.votes = (topic.votes || 0) + 1;
    if (!(topic.voters instanceof Map)) topic.voters = new Map();
    topic.voters.set(actualPid, (topic.voters.get(actualPid) || 0) + 1);
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
    if (actualPid) {
      const yourVotes = normalizeParticipantVotes(meeting, actualPid);
      socket.emit('your_votes', {
        topicCounts: votesRecordToPlainObject(yourVotes),
        max: meeting.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT,
      });
    }
  });

  socket.on('unvote', ({ meetingId, participantId: pid, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    const actualPid = (joinedMeetingId === mid && participantId) ? participantId : pid;
    const record = normalizeParticipantVotes(meeting, actualPid);
    if (!record) return;
    const currentCount = record.topics.get(topicId) || 0;
    if (currentCount <= 0) return;
    if (currentCount === 1) {
      record.topics.delete(topicId);
    } else {
      record.topics.set(topicId, currentCount - 1);
    }
    record.total = Math.max(0, record.total - 1);
    if (record.total === 0) {
      meeting.votesByParticipant.delete(actualPid);
    } else {
      meeting.votesByParticipant.set(actualPid, record);
    }
    topic.votes = Math.max(0, (topic.votes || 0) - 1);
    if (topic.voters instanceof Map) {
      if (currentCount <= 1) topic.voters.delete(actualPid);
      else topic.voters.set(actualPid, currentCount - 1);
    }
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
    if (actualPid) {
      const yourVotes = normalizeParticipantVotes(meeting, actualPid);
      socket.emit('your_votes', {
        topicCounts: votesRecordToPlainObject(yourVotes),
        max: meeting.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT,
      });
    }
  });

  socket.on('move_topic', ({ meetingId, topicId, column, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return; // only admin can move topics
    if (!['todo', 'doing', 'done'].includes(column)) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    topic.column = column;
    if (column === 'doing') {
      meeting.currentTopicId = topic.id;
    } else if (meeting.currentTopicId === topic.id) {
      meeting.currentTopicId = null;
    }
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
  });

  socket.on('delete_topic', ({ meetingId, topicId, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    meeting.topics = meeting.topics.filter(t => t.id !== topicId);
    // Remove votes pointing to this topic
    for (const [pid, record] of meeting.votesByParticipant.entries()) {
      const normalized = normalizeVoteRecordValue(record);
      const count = normalized.topics.get(topicId) || 0;
      if (count > 0) {
        normalized.topics.delete(topicId);
        normalized.total = Math.max(0, normalized.total - count);
        if (normalized.total === 0) meeting.votesByParticipant.delete(pid);
        else meeting.votesByParticipant.set(pid, normalized);
      }
    }
    if (meeting.currentTopicId === topicId) {
      meeting.currentTopicId = null;
    }
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
  });

  socket.on('disconnect', () => {
    // We keep participant counts simple and do not prune on disconnect for MVP
  });

  // Admin: set durations in minutes
  socket.on('set_durations', ({ meetingId, adminToken, create, voting, discuss }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    function toMin(v, fallback) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(1, Math.min(60, n));
    }
    const d = meeting.durations;
    if (create != null) d.create = toMin(create, d.create);
    if (voting != null) d.voting = toMin(voting, d.voting);
    if (discuss != null) d.discuss = toMin(discuss, d.discuss);
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
  });

  socket.on('set_vote_limit', ({ meetingId, adminToken, maxVotes }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    const n = parseInt(maxVotes, 10);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(1, Math.min(10, n));
    meeting.maxVotesPerParticipant = clamped;
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
  });

  // Admin: start a phase with optional minutes override
  socket.on('start_phase', ({ meetingId, adminToken, phase, minutes, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    if (!['create', 'voting', 'discuss'].includes(phase)) return;
    if (phase === 'discuss') {
      const topic = meeting.topics.find(t => t.id === topicId) || (meeting.currentTopicId && meeting.topics.find(t => t.id === meeting.currentTopicId));
      if (!topic) return;
      meeting.currentTopicId = topic.id;
    }
    const durMin = Number.isFinite(minutes) ? minutes : meeting.durations[phase];
    const ms = Math.max(60000, Math.min(60 * 60000, durMin * 60000));
    meeting.phase = phase;
    meeting.phaseEndsAt = Date.now() + ms;
    meeting.phasePaused = false;
    meeting.phaseRemainingMs = null;
    io.to(mid).emit('state', meetingStateForClient(meeting));
    scheduleTimer(mid);
    persist();
  });

  // Admin: add one minute to current phase timer
  socket.on('add_minute', ({ meetingId, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    if (!meeting.phase) return;
    if (meeting.phasePaused) {
      meeting.phaseRemainingMs = Math.max(0, (meeting.phaseRemainingMs || 0) + 60000);
    } else if (meeting.phaseEndsAt) {
      meeting.phaseEndsAt += 60000;
    }
    io.to(mid).emit('state', meetingStateForClient(meeting));
    scheduleTimer(mid);
    persist();
  });

  // Admin: end current phase without advancing
  socket.on('end_phase', ({ meetingId, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    meeting.phase = null;
    meeting.phaseEndsAt = null;
    meeting.phasePaused = false;
    meeting.phaseRemainingMs = null;
    io.to(mid).emit('state', meetingStateForClient(meeting));
    clearTimer(mid);
    persist();
  });

  // Admin: pause/resume controls
  socket.on('pause_phase', ({ meetingId, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    if (!meeting.phase || meeting.phasePaused) return;
    const now = Date.now();
    meeting.phaseRemainingMs = Math.max(0, (meeting.phaseEndsAt || now) - now);
    meeting.phaseEndsAt = null;
    meeting.phasePaused = true;
    io.to(mid).emit('state', meetingStateForClient(meeting));
    clearTimer(mid);
    persist();
  });

  socket.on('resume_phase', ({ meetingId, adminToken }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const authorized = adminToken && adminToken === meeting.adminToken;
    if (!authorized) return;
    if (!meeting.phase || !meeting.phasePaused) return;
    const ms = Math.max(0, meeting.phaseRemainingMs || 0);
    meeting.phaseEndsAt = Date.now() + ms;
    meeting.phaseRemainingMs = null;
    meeting.phasePaused = false;
    io.to(mid).emit('state', meetingStateForClient(meeting));
    scheduleTimer(mid);
    persist();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lean Coffee running at http://localhost:${PORT}`);
});

// ---------------- Persistence & timers ----------------
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const timers = new Map(); // meetingId -> timeout handle

function serialize() {
  const out = {};
  for (const [id, m] of meetings.entries()) {
    out[id] = {
      id: m.id,
      adminToken: m.adminToken,
      topics: m.topics.map(t => ({
        id: t.id, title: t.title, votes: t.votes, column: t.column, createdAt: t.createdAt,
      })),
      participants: Array.from(m.participants),
      votesByParticipant: Array.from(m.votesByParticipant.entries()).map(([pid, record]) => {
        const normalized = normalizeVoteRecordValue(record);
        return [pid, { total: normalized.total, topics: Array.from(normalized.topics.entries()) }];
      }),
      durations: m.durations,
      phase: m.phase,
      phaseEndsAt: m.phaseEndsAt,
      phasePaused: m.phasePaused,
      phaseRemainingMs: m.phaseRemainingMs,
      currentTopicId: m.currentTopicId,
      createdAt: m.createdAt,
      maxVotesPerParticipant: m.maxVotesPerParticipant,
    };
  }
  return out;
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(serialize()));
  } catch (e) {
    console.error('Persist failed:', e);
  }
}

function restore() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const id of Object.keys(raw)) {
      const m = raw[id];
      const meeting = {
        id: m.id,
        adminToken: m.adminToken,
        topics: (m.topics || []).map(t => ({ ...t, voters: new Map() })),
        participants: new Set(m.participants || []),
        votesByParticipant: new Map((m.votesByParticipant || []).map(([pid, value]) => {
          const normalized = normalizeVoteRecordValue(value);
          return [pid, normalized];
        })),
        durations: m.durations || { create: DEFAULT_CREATE_MIN, voting: DEFAULT_VOTING_MIN, discuss: DEFAULT_DISCUSS_MIN },
        phase: m.phase || null,
        phaseEndsAt: m.phaseEndsAt || null,
        phasePaused: !!m.phasePaused,
        phaseRemainingMs: m.phaseRemainingMs || null,
        currentTopicId: m.currentTopicId || null,
        createdAt: m.createdAt || Date.now(),
        maxVotesPerParticipant: m.maxVotesPerParticipant || DEFAULT_MAX_VOTES_PER_PARTICIPANT,
      };
      // If a phase was active, reconcile timer
      if (meeting.phase) {
        const now = Date.now();
        if (meeting.phasePaused) {
          // Keep remaining as-is
        } else if (meeting.phaseEndsAt && meeting.phaseEndsAt > now) {
          // Continue running
          scheduleTimer(id, meeting.phaseEndsAt - now);
        } else if (meeting.phaseEndsAt && meeting.phaseEndsAt <= now) {
          // Expired while down: pause with 0 remaining
          meeting.phasePaused = true; meeting.phaseRemainingMs = 0; meeting.phaseEndsAt = null;
        }
      }
      meetings.set(id, meeting);
    }
  } catch (e) {
    console.error('Restore failed:', e);
  }
}

function clearTimer(meetingId) {
  const h = timers.get(meetingId);
  if (h) { clearTimeout(h); timers.delete(meetingId); }
}

function scheduleTimer(meetingId, overrideMs) {
  clearTimer(meetingId);
  const meeting = meetings.get(meetingId);
  if (!meeting || meeting.phasePaused) return;
  const now = Date.now();
  const ms = typeof overrideMs === 'number' ? overrideMs : ((meeting.phaseEndsAt || 0) - now);
  if (!meeting.phase || ms <= 0) return;
  const handle = setTimeout(() => {
    // Phase expired: pause and notify admins
    meeting.phasePaused = true;
    meeting.phaseRemainingMs = 0;
    meeting.phaseEndsAt = null;
    io.to(meetingId).emit('state', meetingStateForClient(meeting));
    io.to(meetingId).emit('phase_expired', { phase: meeting.phase, meetingId });
    persist();
    clearTimer(meetingId);
  }, ms);
  timers.set(meetingId, handle);
}

// Restore persisted state at boot
restore();
