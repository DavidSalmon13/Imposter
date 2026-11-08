'use strict';

const { shuffle } = require('../lib/shuffle');
const { chatCompletionJson } = require('../lib/openai');

const MM_MIN_PLAYERS = 3;
const MM_MAX_PLAYERS = 10;
const MM_ANSWER_TIME_MS = 60000;
const MM_MAX_ANSWER_VALUE = 1e15;
const MM_USED_QUESTIONS_AVOID_WINDOW = 30;
const MM_CONTENT_CHECK_RETRIES = 3;
const MM_BULLSEYE_BONUS = 2;
const MM_ROTATIONS_PER_MATCH = 2;
// One in four rounds asks the Subject's opinion about a second named player instead of
// about themselves - see generateMindMeldQuestion's otherName branch.
const MM_OTHER_PLAYER_CHANCE = 0.25;
// Roughly one in three rounds is a free-text "judged" question instead of a numeric one -
// see startMmRound's questionKind branch.
const MM_JUDGED_QUESTION_CHANCE = 0.3;
const MM_ANSWER_MAX_LENGTH = 60;

const MM_MAGNITUDE_WORDS = { thousand: 1e3, million: 1e6, billion: 1e9 };
const MM_MAGNITUDE_SUFFIXES = { k: 1e3, m: 1e6, b: 1e9 };

// Keys within room.state.mindmeld to persist (see plans/yes-sketch-a-low-risk-quiet-chipmunk.md).
const SAVED_FIELDS = [
  'rotationOrder',
  'rotationIndex',
  'roundNumber',
  'usedQuestions',
  'scores',
  'rotationsCompleted',
];

/** Mind Meld's namespaced room state. Replaces the former flat room.mm* fields. */
function createState() {
  return {
    rotationOrder: [], // frozen shuffled array of player names, set once at match start
    rotationIndex: 0, // pointer into rotationOrder; current Subject is rotationOrder[rotationIndex]
    roundNumber: 0, // increments each round that actually resolves
    currentQuestion: null, // current round's question text, or null between rounds
    questionKind: null, // 'numeric' | 'judged' for the current round (lazily created pre-migration)
    answerDeadline: null, // epoch ms deadline for non-Subject players, or null
    answers: {}, // name -> submitted number for the current round (includes the Subject's)
    usedQuestions: [], // rolling avoid-list sent to ChatGPT, windowed at MM_USED_QUESTIONS_AVOID_WINDOW
    scores: {}, // name -> cumulative points across the current match
    rotationsCompleted: 0, // increments each time rotationIndex wraps to 0
    judgeReasoning: null, // judged-round reasoning text (lazily created pre-migration)
    judgedRanking: null, // judged-round ranking (lazily created pre-migration)
  };
}

/** @type {Map<string, NodeJS.Timeout>} */
const mmDeadlineHandles = new Map();

function clearMmDeadlineHandle(roomCode) {
  const handle = mmDeadlineHandles.get(roomCode);
  if (handle) clearTimeout(handle);
  mmDeadlineHandles.delete(roomCode);
}

function clearState(room, roomCode) {
  if (roomCode) clearMmDeadlineHandle(roomCode);
  room.state.mindmeld = createState();
}

function mmCurrentSubject(room) {
  return room.state.mindmeld.rotationOrder.length ? room.state.mindmeld.rotationOrder[room.state.mindmeld.rotationIndex] : null;
}

function mmStatePayload(ctx, room, viewerName) {
  const subjectName = mmCurrentSubject(room);
  const payload = {
    game: 'mindmeld',
    phase: room.phase,
    host: room.hostName,
    players: room.phase === 'ready' ? ctx.connectedNames(room) : room.state.mindmeld.rotationOrder.slice(),
    roundNumber: room.state.mindmeld.roundNumber,
    subjectName,
    isSubject: viewerName != null && viewerName === subjectName,
    questionKind: room.state.mindmeld.questionKind || null,
    question:
      room.phase === 'answering' || room.phase === 'judging' ? room.state.mindmeld.currentQuestion : null,
    answerDeadline: room.phase === 'answering' ? room.state.mindmeld.answerDeadline : null,
    mySubmitted:
      viewerName != null && Object.prototype.hasOwnProperty.call(room.state.mindmeld.answers || {}, viewerName),
  };

  if (room.phase === 'revealed') {
    const target = room.state.mindmeld.answers[subjectName];
    payload.target = target;
    if (room.state.mindmeld.questionKind === 'judged') {
      payload.ranking = room.state.mindmeld.judgedRanking || [];
      payload.judgeReasoning = room.state.mindmeld.judgeReasoning || '';
    } else {
      const answers = {};
      for (const [name, guess] of Object.entries(room.state.mindmeld.answers)) {
        if (name !== subjectName) answers[name] = guess;
      }
      payload.ranking = computeMmRanking(target, answers);
    }
    payload.scores = { ...room.state.mindmeld.scores };
  }

  if (room.phase === 'gameover') {
    payload.standings = mmFinalStandings(room);
    payload.scoreboard = ctx.scoreboardEntries(room);
  }

  return payload;
}

function broadcastMm(ctx, roomCode, room) {
  for (const [name, p] of room.players.entries()) {
    if (!p.connected || !p.socketId) continue;
    ctx.io.to(p.socketId).emit('mmState', mmStatePayload(ctx, room, name));
  }
}

/**
 * Normalizes an answer input into a canonical non-negative integer, or null if it doesn't
 * parse. Accepts plain digits (with optional commas), a decimal with a k/m/b suffix, or a
 * decimal with a spelled-out magnitude word - see "Answer input & number parsing" in the spec.
 * Pure, no room/ctx dependency.
 */
function parseMmNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('-')) return null;
  if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/,/g, '');

  let numPart = s;
  let multiplier = 1;

  const wordMatch = s.match(/^([\d.]+)\s*(thousand|million|billion)$/);
  const suffixMatch = !wordMatch && s.match(/^([\d.]+)\s*(k|m|b)$/);

  if (wordMatch) {
    numPart = wordMatch[1];
    multiplier = MM_MAGNITUDE_WORDS[wordMatch[2]];
  } else if (suffixMatch) {
    numPart = suffixMatch[1];
    multiplier = MM_MAGNITUDE_SUFFIXES[suffixMatch[2]];
  }

  if (!/^\d+(\.\d+)?$/.test(numPart)) return null;

  const value = parseFloat(numPart) * multiplier;
  if (!Number.isFinite(value) || value < 0 || value > MM_MAX_ANSWER_VALUE) return null;

  return Math.round(value);
}

/**
 * Pure ranking + scoring for one round. `answers` is {name: number} and must already exclude
 * the Subject; `target` is the Subject's own number. Implements the spec's percentage-diff sort
 * (falling back to plain absolute difference when target === 0, to avoid a divide-by-zero),
 * standard-competition tie/rank-skip, and the per-player bullseye bonus. `N` (used for the
 * points scale) is derived purely from who actually answered this round - a player who never
 * submits (DNF) is simply absent from `answers` and doesn't shrink anyone else's rank points.
 * `pctDiff` holds the plain absolute difference (not a percentage) when target === 0.
 */
function computeMmRanking(target, answers) {
  const totalPlayers = Object.keys(answers).length + 1; // +1 for the un-ranked Subject
  const entries = Object.entries(answers).map(([name, guess]) => {
    const diff = Math.abs(guess - target);
    const metric = target === 0 ? diff : (diff / target) * 100;
    return { name, guess, metric, bullseye: guess === target };
  });

  entries.sort((a, b) => a.metric - b.metric || a.name.localeCompare(b.name));

  const results = [];
  let i = 0;
  while (i < entries.length) {
    let j = i + 1;
    while (j < entries.length && entries[j].metric === entries[i].metric) j += 1;
    const rank = i + 1;
    const rankPoints = totalPlayers - rank;
    for (let k = i; k < j; k++) {
      const e = entries[k];
      results.push({
        name: e.name,
        guess: e.guess,
        pctDiff: e.metric,
        rank,
        points: rankPoints + (e.bullseye ? MM_BULLSEYE_BONUS : 0),
        bullseye: e.bullseye,
      });
    }
    i = j;
  }
  return results;
}

/** Picks a random other player from the frozen rotation to be the subject of an "about someone else" question. */
function pickMmOtherPlayer(room, subjectName) {
  const others = room.state.mindmeld.rotationOrder.filter((name) => name !== subjectName);
  if (!others.length) return null;
  return others[Math.floor(Math.random() * others.length)];
}

async function generateMindMeldQuestion(room, subjectName, otherName) {
  const avoid = room.state.mindmeld.usedQuestions.slice(-MM_USED_QUESTIONS_AVOID_WINDOW);
  const avoidClause = avoid.length
    ? ` These questions were already used this match - write something different from all of them: ` +
      avoid.map((q) => `"${q}"`).join(', ') + '.'
    : '';
  const languageInstruction = room.wordLanguage === 'hebrew' ? ' Write the question in Hebrew.' : '';
  const toneClause =
    `TONE: go absolutely wild - lean hard into funny, naughty, and crazy territory (sex, hookups, ` +
    `dating disasters, money-for-crazy-dares, gross-out humor, deranged hypotheticals - anything ` +
    `goes) at least as often as tamer stuff. Don't play it safe, don't be generic, and don't settle ` +
    `for the first mundane idea that comes to mind. The only hard rule: stay PLAYFUL, never CRUEL - ` +
    `no slurs, no hate speech, and nothing that reads as a genuine personal attack on someone's ` +
    `intelligence, worth, appearance, or health. This should be the kind of question that gets a ` +
    `table laughing, not one that actually humiliates someone.`;
  const numberClause =
    `NUMBERS: aim big - favor questions whose honest answer could plausibly land in the hundreds, ` +
    `thousands, or higher, rather than a tame single-digit count.`;

  const prompt = otherName
    ? `You are generating one question for a party game called Mind Meld. A rotating "Subject" player ` +
      `gets an outrageous numeric-estimate question, and everyone else tries to guess what number the ` +
      `Subject will answer.\n\n` +
      `The Subject this round is named "${subjectName}". This particular question should be about ANOTHER ` +
      `player at the table named "${otherName}" - phrased as a request for ${subjectName}'s own personal ` +
      `opinion/guess about ${otherName} (not an objective fact), asking for a single non-negative ` +
      `number.${languageInstruction}\n\n` +
      toneClause +
      ' ' +
      numberClause +
      avoidClause +
      ` Respond with ONLY compact JSON in the form {"question": "..."}.`
    : `You are generating one question for a party game called Mind Meld. A rotating "Subject" player ` +
      `gets an outrageous numeric-estimate question about themselves, and everyone else tries to guess ` +
      `what number the Subject will answer.\n\n` +
      `The Subject this round is named "${subjectName}". Write ONE question, phrased as a request for ` +
      `${subjectName}'s own personal estimate/opinion (not an objective fact), asking for a single ` +
      `non-negative number.${languageInstruction}\n\n` +
      toneClause +
      ' ' +
      numberClause +
      avoidClause +
      ` Respond with ONLY compact JSON in the form {"question": "..."}.`;

  for (let attempt = 0; attempt < MM_CONTENT_CHECK_RETRIES; attempt++) {
    const parsed = await chatCompletionJson(prompt, { temperature: 1.1 });
    const question = String((parsed && parsed.question) || '').trim();
    if (question) {
      return { question };
    }
  }
  throw new Error('Could not generate a question - please try again');
}

/**
 * Same shape as generateMindMeldQuestion, but for the free-text "judged" question kind - the
 * answer is a short phrase/name/word instead of a number, and there's no numeric ranking; a
 * judge LLM call (see judgeMmAnswers) ranks the guesses against the Subject's own answer instead.
 */
async function generateMindMeldTextQuestion(room, subjectName, otherName) {
  const avoid = room.state.mindmeld.usedQuestions.slice(-MM_USED_QUESTIONS_AVOID_WINDOW);
  const avoidClause = avoid.length
    ? ` These questions were already used this match - write something different from all of them: ` +
      avoid.map((q) => `"${q}"`).join(', ') + '.'
    : '';
  const languageInstruction = room.wordLanguage === 'hebrew' ? ' Write the question in Hebrew.' : '';
  const toneClause =
    `TONE: go absolutely wild - lean hard into funny, naughty, and crazy territory (sex, hookups, ` +
    `dating disasters, money-for-crazy-dares, gross-out humor, deranged hypotheticals - anything ` +
    `goes) at least as often as tamer stuff. Don't play it safe, don't be generic, and don't settle ` +
    `for the first mundane idea that comes to mind. The only hard rule: stay PLAYFUL, never CRUEL - ` +
    `no slurs, no hate speech, and nothing that reads as a genuine personal attack on someone's ` +
    `intelligence, worth, appearance, or health. This should be the kind of question that gets a ` +
    `table laughing, not one that actually humiliates someone.`;
  const formatClause =
    `The answer must be a short phrase, name, or word (NOT a number) - something everyone else at the ` +
    `table can take a one- or two-word guess at.`;

  const prompt = otherName
    ? `You are generating one question for a party game called Mind Meld. A rotating "Subject" player ` +
      `gets an outrageous open-ended question, and everyone else tries to guess what the Subject will ` +
      `answer.\n\n` +
      `The Subject this round is named "${subjectName}". This particular question should be about ANOTHER ` +
      `player at the table named "${otherName}" - phrased as a request for ${subjectName}'s own personal ` +
      `opinion/guess about ${otherName}. ${formatClause}${languageInstruction}\n\n` +
      toneClause +
      avoidClause +
      ` Respond with ONLY compact JSON in the form {"question": "..."}.`
    : `You are generating one question for a party game called Mind Meld. A rotating "Subject" player ` +
      `gets an outrageous open-ended question about themselves, and everyone else tries to guess what the ` +
      `Subject will answer.\n\n` +
      `The Subject this round is named "${subjectName}". Write ONE question, phrased as a request for ` +
      `${subjectName}'s own personal opinion. ${formatClause}${languageInstruction}\n\n` +
      toneClause +
      avoidClause +
      ` Respond with ONLY compact JSON in the form {"question": "..."}.`;

  for (let attempt = 0; attempt < MM_CONTENT_CHECK_RETRIES; attempt++) {
    const parsed = await chatCompletionJson(prompt, { temperature: 1.1 });
    const question = String((parsed && parsed.question) || '').trim();
    if (question) {
      return { question };
    }
  }
  throw new Error('Could not generate a question - please try again');
}

/**
 * Sends the Subject's free-text answer plus everyone else's guesses to a judge LLM, which orders
 * the guesses from closest-in-spirit to least close and gives a short reasoning blurb. Unlike
 * computeMmRanking, this returns a strict order with no ties - a semantic judgment call, not a
 * computed metric. `answers` is {name: text} and must already exclude the Subject.
 */
async function judgeMmAnswers(room, question, subjectName, subjectAnswer, answers) {
  const guessList = Object.entries(answers)
    .map(([name, text]) => `${name}: "${text}"`)
    .join('\n');
  const languageInstruction = room.wordLanguage === 'hebrew' ? ' Write your reasoning in Hebrew.' : '';
  const prompt =
    `You are the judge for a party game called Mind Meld. The question this round was: "${question}"\n\n` +
    `${subjectName} (the Subject) gave this answer: "${subjectAnswer}"\n\n` +
    `Now rank the other players' guesses below by how closely each one matches what ${subjectName} ` +
    `actually said - judge by meaning and spirit (the same person, thing, or idea referenced differently ` +
    `should count as a strong match), not exact string matching.\n\n${guessList}\n\n` +
    `Respond with ONLY compact JSON in the form {"ranking": [<array of every player name above, ordered ` +
    `from closest match to least close>], "reasoning": "one or two witty sentences explaining the ` +
    `ranking, referencing specific guesses by name"}.${languageInstruction}`;

  const parsed = await chatCompletionJson(prompt, { temperature: 0.7 });
  const names = Object.keys(answers);
  const rawRanking = Array.isArray(parsed && parsed.ranking) ? parsed.ranking : [];
  const ranking = rawRanking.filter((n) => names.includes(n));
  for (const name of names) {
    if (!ranking.includes(name)) ranking.push(name); // model omitted someone - append in original order
  }
  const reasoning = String((parsed && parsed.reasoning) || '').trim();
  return { ranking, reasoning };
}

/** Ranks the round, fans points into room.state.mindmeld.scores, and moves to 'revealed'. */
async function resolveMmRound(ctx, roomCode, room) {
  clearMmDeadlineHandle(roomCode);
  const subjectName = mmCurrentSubject(room);
  const target = room.state.mindmeld.answers[subjectName];
  const answers = {};
  for (const [name, guess] of Object.entries(room.state.mindmeld.answers)) {
    if (name !== subjectName) answers[name] = guess;
  }

  if (room.state.mindmeld.questionKind === 'judged') {
    room.phase = 'judging';
    broadcastMm(ctx, roomCode, room);

    let ranking;
    let reasoning;
    let judgeFailed = false;
    try {
      ({ ranking, reasoning } = await judgeMmAnswers(room, room.state.mindmeld.currentQuestion, subjectName, target, answers));
    } catch (err) {
      console.error('judgeMmAnswers failed:', err.message);
      judgeFailed = true;
      ranking = Object.keys(answers);
      reasoning = "The judge couldn't reach a verdict this round, so everyone shares the points.";
    }

    // Room may have been deleted, or the round already voided by a Subject disconnect, while awaiting the judge.
    if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;
    if (room.phase !== 'judging') return;

    const totalPlayers = ranking.length + 1; // +1 for the un-ranked Subject
    const scored = judgeFailed
      ? ranking.map((name) => ({ name, guess: answers[name], rank: 1, points: Math.max(totalPlayers - 1, 0) }))
      : ranking.map((name, i) => ({ name, guess: answers[name], rank: i + 1, points: totalPlayers - (i + 1) }));

    for (const r of scored) {
      room.state.mindmeld.scores[r.name] = (room.state.mindmeld.scores[r.name] || 0) + r.points;
    }

    room.state.mindmeld.judgedRanking = scored;
    room.state.mindmeld.judgeReasoning = reasoning;
    room.state.mindmeld.answerDeadline = null;
    room.phase = 'revealed';
    broadcastMm(ctx, roomCode, room);
    return;
  }

  const ranking = computeMmRanking(target, answers);
  for (const r of ranking) {
    room.state.mindmeld.scores[r.name] = (room.state.mindmeld.scores[r.name] || 0) + r.points;
  }
  // The Subject always scores 0 this round - they're never in `ranking`, so their score is
  // simply left untouched above.

  room.state.mindmeld.answerDeadline = null;
  room.phase = 'revealed';
  broadcastMm(ctx, roomCode, room);
}

/**
 * Resolves the current round once the Subject has answered and either every currently-connected
 * non-Subject active player has also answered (early resolve) or the deadline has passed.
 */
function maybeResolveMmRound(ctx, roomCode, room) {
  if (!room || room.game !== 'mindmeld' || room.phase !== 'answering') return;
  const subjectName = mmCurrentSubject(room);
  if (!subjectName || !Object.prototype.hasOwnProperty.call(room.state.mindmeld.answers, subjectName)) return;

  const deadlinePassed = room.state.mindmeld.answerDeadline != null && Date.now() >= room.state.mindmeld.answerDeadline;
  if (!deadlinePassed) {
    const stillWaitingOn = room.state.mindmeld.rotationOrder.some((name) => {
      if (name === subjectName) return false;
      const p = room.players.get(name);
      if (!p || !p.connected) return false; // disconnected players don't block early resolve
      return !Object.prototype.hasOwnProperty.call(room.state.mindmeld.answers, name);
    });
    if (stillWaitingOn) return;
  }

  resolveMmRound(ctx, roomCode, room);
}

/** At `room.state.mindmeld.answerDeadline`, re-checks whether the round can now resolve (Subject-only wait). */
function scheduleMmDeadlineHandle(ctx, roomCode, room) {
  clearMmDeadlineHandle(roomCode);
  if (!room.state.mindmeld.answerDeadline) return;
  const fire = () => {
    const freshRoom = ctx.rooms.get(roomCode);
    if (freshRoom) maybeResolveMmRound(ctx, roomCode, freshRoom);
  };
  const delay = room.state.mindmeld.answerDeadline - Date.now();
  if (delay <= 0) {
    fire();
    return;
  }
  mmDeadlineHandles.set(roomCode, setTimeout(fire, delay));
}

/** Reverts a failed OpenAI call - `fallbackPhase` is 'ready' for round 1, 'revealed' otherwise. */
function failMmRound(ctx, roomCode, room, error, fallbackPhase) {
  clearMmDeadlineHandle(roomCode);
  room.phase = fallbackPhase;
  room.state.mindmeld.currentQuestion = null;
  room.state.mindmeld.answerDeadline = null;
  broadcastMm(ctx, roomCode, room);
  // Namespaced (not the shared 'startFailed') - Imposter's client keeps a permanent global
  // listener on that event that would otherwise hijack the screen away from Mind Meld's own
  // ready/revealed panel. Mirrors Music Timeline's 'mtStartFailed' precedent for the same reason.
  ctx.roomEmit(roomCode, 'mmStartFailed', { error });
}

/** The pickingSubject -> generating -> answering step. */
async function startMmRound(ctx, roomCode, room, fallbackPhase) {
  const subjectName = mmCurrentSubject(room);
  room.phase = 'generating';
  ctx.roomEmit(roomCode, 'generating', { game: 'mindmeld' });

  const otherName =
    Math.random() < MM_OTHER_PLAYER_CHANCE ? pickMmOtherPlayer(room, subjectName) : null;
  const questionKind = Math.random() < MM_JUDGED_QUESTION_CHANCE ? 'judged' : 'number';

  let question;
  try {
    ({ question } =
      questionKind === 'judged'
        ? await generateMindMeldTextQuestion(room, subjectName, otherName)
        : await generateMindMeldQuestion(room, subjectName, otherName));
  } catch (err) {
    console.error('generateMindMeldQuestion failed:', err.message);
    return failMmRound(
      ctx,
      roomCode,
      room,
      'Could not reach ChatGPT to come up with a question. Please try again.',
      fallbackPhase
    );
  }

  // Room may have been deleted (or a new round already started) while awaiting OpenAI.
  if (!ctx.rooms.has(roomCode) || ctx.rooms.get(roomCode) !== room) return;

  room.state.mindmeld.usedQuestions.push(question);
  if (room.state.mindmeld.usedQuestions.length > MM_USED_QUESTIONS_AVOID_WINDOW) {
    room.state.mindmeld.usedQuestions.splice(0, room.state.mindmeld.usedQuestions.length - MM_USED_QUESTIONS_AVOID_WINDOW);
  }
  room.state.mindmeld.questionKind = questionKind;
  room.state.mindmeld.currentQuestion = question;
  room.state.mindmeld.answerDeadline = Date.now() + MM_ANSWER_TIME_MS;
  room.state.mindmeld.answers = {};
  room.state.mindmeld.judgeReasoning = null;
  room.state.mindmeld.judgedRanking = null;
  room.phase = 'answering';
  scheduleMmDeadlineHandle(ctx, roomCode, room);
  broadcastMm(ctx, roomCode, room);
}

/** (Re-)shuffles a fresh rotation and zeroes every per-match field - shared by Start and Play Again. */
function beginMmMatch(room, names) {
  room.state.mindmeld.rotationOrder = shuffle(names);
  room.state.mindmeld.rotationIndex = 0;
  room.state.mindmeld.roundNumber = 0;
  room.state.mindmeld.scores = {};
  for (const name of room.state.mindmeld.rotationOrder) room.state.mindmeld.scores[name] = 0;
  room.state.mindmeld.rotationsCompleted = 0;
  room.state.mindmeld.usedQuestions = [];
}

/** Advances the rotation pointer (wrapping); returns whether the match is now complete. */
function advanceMmRotation(room) {
  room.state.mindmeld.rotationIndex = (room.state.mindmeld.rotationIndex + 1) % room.state.mindmeld.rotationOrder.length;
  if (room.state.mindmeld.rotationIndex === 0) room.state.mindmeld.rotationsCompleted += 1;
  return room.state.mindmeld.rotationsCompleted >= MM_ROTATIONS_PER_MATCH;
}

/** Final per-player standings ranked by cumulative match score, descending (ties share rank/points). */
function mmFinalStandings(room) {
  const ranked = room.state.mindmeld.rotationOrder
    .map((name) => ({ name, score: room.state.mindmeld.scores[name] || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const N = ranked.length;
  const results = [];
  let i = 0;
  while (i < ranked.length) {
    let j = i + 1;
    while (j < ranked.length && ranked[j].score === ranked[i].score) j += 1;
    const rank = i + 1;
    const points = N - i;
    for (let k = i; k < j; k++) {
      results.push({ name: ranked[k].name, score: ranked[k].score, rank, points });
    }
    i = j;
  }
  return results;
}

/** Fans final standings points into the shared room scoreboard. */
function awardMmScoreboard(ctx, room) {
  const standings = mmFinalStandings(room);
  for (const s of standings) {
    ctx.addScore(room, s.name, s.points);
  }
  ctx.recordGameResult(
    room,
    'mindmeld',
    standings.map((s) => ({
      name: s.name,
      won: s.rank === 1,
      points: s.points,
      details: { score: s.score, place: s.rank },
    }))
  );
}

/**
 * Shared by mmNextRound and voidMmRound: advances the rotation, then either starts the next
 * round or - if that wrap completed the match - awards the scoreboard and ends it. A voided
 * round (no scores awarded) can still complete the match on its own if its wrap is the final
 * one; the spec doesn't call this out explicitly, but the rotation is what defines match length,
 * so a completing wrap ends the match regardless of whether the round it wrapped on scored.
 */
function continueOrEndMmMatch(ctx, roomCode, room, fallbackPhase) {
  const matchComplete = advanceMmRotation(room);
  if (matchComplete) {
    awardMmScoreboard(ctx, room);
    room.phase = 'gameover';
    broadcastMm(ctx, roomCode, room);
    return;
  }
  startMmRound(ctx, roomCode, room, fallbackPhase);
}

/** The Subject-disconnect path: voids the round (nobody scores) and advances the rotation. */
function voidMmRound(ctx, roomCode, room) {
  clearMmDeadlineHandle(roomCode);
  room.state.mindmeld.answers = {};
  room.state.mindmeld.currentQuestion = null;
  room.state.mindmeld.answerDeadline = null;
  continueOrEndMmMatch(ctx, roomCode, room, 'ready');
}

function onChoose(ctx, roomCode, room) {
  clearState(room, roomCode);
  room.phase = 'ready';
  broadcastMm(ctx, roomCode, room);
}

function registerHandlers(ctx, io, socket) {
  socket.on('startMindMeld', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'mindmeld' || room.phase !== 'ready') {
      return callback({ ok: false, error: 'Not ready to start' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can start' });
    }

    // A frozen roster already exists - this 'ready' is a retry after a failed round (or a
    // resume after a server restart mid-round, see repairOnLoad), not a brand-new match. Reuse
    // the existing rotation/scores instead of reshuffling and wiping match progress.
    if (room.state.mindmeld.rotationOrder.length > 0) {
      callback({ ok: true });
      startMmRound(ctx, roomCode, room, 'ready');
      return;
    }

    const names = ctx.connectedNames(room);
    if (names.length < MM_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MM_MIN_PLAYERS} players` });
    }
    if (names.length > MM_MAX_PLAYERS) {
      return callback({ ok: false, error: `Mind Meld supports at most ${MM_MAX_PLAYERS} players` });
    }

    beginMmMatch(room, names);

    callback({ ok: true });
    startMmRound(ctx, roomCode, room, 'ready');
  });

  socket.on('mmNextRound', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'mindmeld' || room.phase !== 'revealed') {
      return callback({ ok: false, error: 'No results to continue from' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can continue' });
    }

    callback({ ok: true });
    continueOrEndMmMatch(ctx, roomCode, room, 'revealed');
  });

  socket.on('playAgainMindMeld', (callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'mindmeld' || room.phase !== 'gameover') {
      return callback({ ok: false, error: 'Match is not over yet' });
    }
    if (socket.data.name !== room.hostName) {
      return callback({ ok: false, error: 'Only the host can play again' });
    }

    const names = ctx.connectedNames(room);
    if (names.length < MM_MIN_PLAYERS) {
      return callback({ ok: false, error: `Need at least ${MM_MIN_PLAYERS} players` });
    }
    if (names.length > MM_MAX_PLAYERS) {
      return callback({ ok: false, error: `Mind Meld supports at most ${MM_MAX_PLAYERS} players` });
    }

    beginMmMatch(room, names);
    room.phase = 'ready';

    callback({ ok: true });
    broadcastMm(ctx, roomCode, room);
  });

  socket.on('submitMmAnswer', (data, callback) => {
    callback = callback || (() => {});
    const roomCode = socket.data.roomCode;
    const room = ctx.getRoom(socket);
    if (!room) return callback({ ok: false, error: 'Not in a room' });
    if (room.game !== 'mindmeld' || room.phase !== 'answering') {
      return callback({ ok: false, error: 'Not answering right now' });
    }

    const name = socket.data.name;
    if (!room.state.mindmeld.rotationOrder.includes(name)) {
      return callback({ ok: false, error: 'Not in this match' });
    }
    if (Object.prototype.hasOwnProperty.call(room.state.mindmeld.answers, name)) {
      return callback({ ok: false, error: 'Already submitted' });
    }

    const isSubject = name === mmCurrentSubject(room);
    if (!isSubject && room.state.mindmeld.answerDeadline != null && Date.now() >= room.state.mindmeld.answerDeadline) {
      return callback({ ok: false, error: 'Too late - the timer ran out' });
    }

    let value;
    if (room.state.mindmeld.questionKind === 'judged') {
      const raw = typeof (data && data.raw) === 'string' ? data.raw.trim() : '';
      if (!raw) return callback({ ok: false, error: 'Enter an answer' });
      if (raw.length > MM_ANSWER_MAX_LENGTH) {
        return callback({ ok: false, error: `Keep it under ${MM_ANSWER_MAX_LENGTH} characters` });
      }
      value = raw;
    } else {
      value = parseMmNumber(data && data.raw);
      if (value === null) {
        return callback({ ok: false, error: 'Enter a valid non-negative number' });
      }
    }

    room.state.mindmeld.answers[name] = value;
    callback({ ok: true });
    broadcastMm(ctx, roomCode, room);
    maybeResolveMmRound(ctx, roomCode, room);
  });
}

function reconnectPayload(ctx, room, existingPlayer) {
  let viewerName = null;
  for (const [n, p] of room.players.entries()) {
    if (p === existingPlayer) {
      viewerName = n;
      break;
    }
  }
  return { ok: true, ...mmStatePayload(ctx, room, viewerName) };
}

/**
 * A non-Subject disconnect during 'answering' needs no special handling: it's already
 * indistinguishable from "never got around to submitting" for scoring purposes (both are simply
 * absent from `room.state.mindmeld.answers`), so the existing DNF/exclusion path covers it - just re-broadcast
 * in case any waitingOn-style UI needs to update. A disconnecting Subject is the one case that
 * needs action, since the round can never resolve without their number.
 */
function onDisconnect(ctx, roomCode, room, name) {
  if (room.phase === 'answering' && name === mmCurrentSubject(room)) {
    voidMmRound(ctx, roomCode, room);
    return;
  }
  broadcastMm(ctx, roomCode, room);
}

function onReconnectBroadcast(ctx, roomCode, room) {
  broadcastMm(ctx, roomCode, room);
}

/**
 * currentQuestion/answerDeadline/answers/judge* are deliberately not in savedFields
 * (in-flight round state, same simplification Menifot/Music Timeline's own generating-rollback
 * uses) - so none of 'generating'/'answering'/'judging'/'revealed' can actually resume after a
 * restart (an in-flight OpenAI call can't be resumed, and a restart during answering/judging/
 * revealed loses the very state those screens need to render). All four roll back to 'ready',
 * where the frozen roster/scores are intact and a Start press regenerates the stuck round via
 * the retry path above.
 */
function repairOnLoad(ctx, room) {
  if (!['generating', 'answering', 'judging', 'revealed'].includes(room.phase)) return;
  room.state.mindmeld.currentQuestion = null;
  room.state.mindmeld.questionKind = null;
  room.state.mindmeld.answerDeadline = null;
  room.state.mindmeld.answers = {};
  room.state.mindmeld.judgeReasoning = null;
  room.state.mindmeld.judgedRanking = null;
  room.phase = 'ready';
}

module.exports = {
  id: 'mindmeld',
  minPlayers: MM_MIN_PLAYERS,
  maxPlayers: MM_MAX_PLAYERS,
  onChoose,
  registerHandlers,
  reconnectPayload,
  onDisconnect,
  onReconnectBroadcast,
  repairOnLoad,
  namespaces: [{ id: 'mindmeld', createState, savedFields: SAVED_FIELDS }],
  clearState,
};
