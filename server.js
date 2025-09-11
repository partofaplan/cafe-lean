const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Config
const PORT = process.env.PORT || 3000;
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

// Simple landing page to create/join
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Create a meeting
app.post('/api/create', (req, res) => {
  const meetingId = ID();
  const adminToken = ID() + ID(); // 12 chars
  meetings.set(meetingId, {
    id: meetingId,
    adminToken,
    topics: [],
    participants: new Set(),
    votesByParticipant: new Map(),
    createdAt: Date.now(),
  });
  res.json({
    meetingId,
    adminToken,
    boardUrl: `/board/${meetingId}`,
    joinUrl: `/join/${meetingId}`,
    adminUrl: `/admin/${meetingId}`,
  });
});

// Basic route guards to ensure meeting exists
app.get(['/board/:id', '/admin/:id', '/join/:id'], (req, res, next) => {
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
app.get('/join/:id', (req, res) => {
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
    config: { MAX_VOTES_PER_PARTICIPANT }
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
    participantId = id || socket.id; // basic identity
    isAdmin = role === 'admin' && adminToken === meeting.adminToken;
    meeting.participants.add(participantId);
    socket.join(mid);
    socket.emit('state', meetingStateForClient(meeting));
  });

  socket.on('submit_topic', ({ meetingId, title, authorId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting || !title || !authorId) return;
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
  });

  socket.on('vote', ({ meetingId, participantId: pid, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    const votes = meeting.votesByParticipant.get(pid) || new Set();
    if (votes.has(topicId)) return; // already voted for this topic
    if (votes.size >= MAX_VOTES_PER_PARTICIPANT) return; // limit reached

    votes.add(topicId);
    meeting.votesByParticipant.set(pid, votes);
    topic.votes = (topic.votes || 0) + 1;
    topic.voters.add(pid);
    io.to(mid).emit('state', meetingStateForClient(meeting));
  });

  socket.on('unvote', ({ meetingId, participantId: pid, topicId }) => {
    const mid = (meetingId || '').toUpperCase();
    const meeting = meetings.get(mid);
    if (!meeting) return;
    const topic = meeting.topics.find(t => t.id === topicId);
    if (!topic) return;
    const votes = meeting.votesByParticipant.get(pid);
    if (!votes || !votes.has(topicId)) return;
    votes.delete(topicId);
    topic.votes = Math.max(0, (topic.votes || 0) - 1);
    topic.voters.delete(pid);
    io.to(mid).emit('state', meetingStateForClient(meeting));
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
    io.to(mid).emit('state', meetingStateForClient(meeting));
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
    io.to(mid).emit('state', meetingStateForClient(meeting));
  });

  socket.on('disconnect', () => {
    // We keep participant counts simple and do not prune on disconnect for MVP
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lean Coffee running at http://localhost:${PORT}`);
});
