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
const MAX_VOTES_PER_PARTICIPANT = parseInt(process.env.MAX_VOTES || '3', 10);

// In-memory store (MVP)
// meetings: { [meetingId]: { id, adminToken, topics: Topic[], participants: Set<string>, votesByParticipant: Map<participantId, Set<topicId>> } }
const meetings = new Map();

/**
 * Topic shape:
 * { id, title, authorId, votes: number, voters: Set<participantId>, column: 'todo'|'doing'|'done', createdAt }
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
      votesCast: Array.from(meeting.votesByParticipant.values()).reduce((acc, set) => acc + set.size, 0)
    },
    config: { MAX_VOTES_PER_PARTICIPANT },
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
      const yourVotes = meeting.votesByParticipant.get(participantId) || new Set();
      socket.emit('your_votes', { topicIds: Array.from(yourVotes), max: MAX_VOTES_PER_PARTICIPANT });
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
      voters: new Set(),
      column: 'todo',
      createdAt: Date.now(),
    };
    meeting.topics.push(topic);
    io.to(mid).emit('state', meetingStateForClient(meeting));
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
    const votes = meeting.votesByParticipant.get(actualPid) || new Set();
    if (votes.has(topicId)) return; // already voted for this topic
    if (votes.size >= MAX_VOTES_PER_PARTICIPANT) return; // limit reached

    votes.add(topicId);
    meeting.votesByParticipant.set(actualPid, votes);
    topic.votes = (topic.votes || 0) + 1;
    topic.voters.add(actualPid);
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
    if (actualPid) {
      const yourVotes = meeting.votesByParticipant.get(actualPid) || new Set();
      socket.emit('your_votes', { topicIds: Array.from(yourVotes), max: MAX_VOTES_PER_PARTICIPANT });
    }
  });

  socket.on('unvote', ({ meetingId, participantId: pid, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    const actualPid = (joinedMeetingId === mid && participantId) ? participantId : pid;
    const votes = meeting.votesByParticipant.get(actualPid);
    if (!votes || !votes.has(topicId)) return;
    votes.delete(topicId);
    topic.votes = Math.max(0, (topic.votes || 0) - 1);
    topic.voters.delete(actualPid);
    io.to(mid).emit('state', meetingStateForClient(meeting));
    persist();
    if (actualPid) {
      const yourVotes = meeting.votesByParticipant.get(actualPid) || new Set();
      socket.emit('your_votes', { topicIds: Array.from(yourVotes), max: MAX_VOTES_PER_PARTICIPANT });
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
    for (const set of meeting.votesByParticipant.values()) {
      if (set.has(topicId)) set.delete(topicId);
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
      votesByParticipant: Array.from(m.votesByParticipant.entries()).map(([pid, set]) => [pid, Array.from(set)]),
      durations: m.durations,
      phase: m.phase,
      phaseEndsAt: m.phaseEndsAt,
      phasePaused: m.phasePaused,
      phaseRemainingMs: m.phaseRemainingMs,
      currentTopicId: m.currentTopicId,
      createdAt: m.createdAt,
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
        topics: (m.topics || []).map(t => ({ ...t, voters: new Set() })),
        participants: new Set(m.participants || []),
        votesByParticipant: new Map((m.votesByParticipant || []).map(([pid, arr]) => [pid, new Set(arr)])),
        durations: m.durations || { create: DEFAULT_CREATE_MIN, voting: DEFAULT_VOTING_MIN, discuss: DEFAULT_DISCUSS_MIN },
        phase: m.phase || null,
        phaseEndsAt: m.phaseEndsAt || null,
        phasePaused: !!m.phasePaused,
        phaseRemainingMs: m.phaseRemainingMs || null,
        currentTopicId: m.currentTopicId || null,
        createdAt: m.createdAt || Date.now(),
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
